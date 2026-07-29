#include "platform/native_view.h"

#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>

#include <dlfcn.h>

namespace fongmi {
namespace {

NSRect FrameForAttachment(NSView* parent, int x, int y, int width, int height) {
  const CGFloat frameY = parent.isFlipped
    ? static_cast<CGFloat>(y)
    : NSHeight(parent.bounds) - static_cast<CGFloat>(y + height);
  return NSMakeRect(static_cast<CGFloat>(x), frameY,
                    static_cast<CGFloat>(width), static_cast<CGFloat>(height));
}

void* ResolveOpenGLSymbol(void* /*context*/, const char* name) {
  return name ? dlsym(RTLD_DEFAULT, name) : nullptr;
}

}  // namespace
}  // namespace fongmi

@interface FongMiMpvOpenGLView : NSOpenGLView {
 @private
  fongmi::NativeViewAttachment _attachment;
  BOOL _rendererInitialized;
  BOOL _rendererShuttingDown;
  NSString* _rendererError;
}
- (instancetype)initWithFrame:(NSRect)frame attachment:(const fongmi::NativeViewAttachment&)attachment;
- (BOOL)initializeRendererNow;
- (void)shutdownRenderer;
- (NSString*)rendererError;
@end

namespace fongmi {
namespace {

void RequestDarwinRedraw(void* context) {
  if (!context) return;
  CFRetain(context);
  dispatch_async(dispatch_get_main_queue(), ^{
    FongMiMpvOpenGLView* view = (__bridge FongMiMpvOpenGLView*)context;
    [view setNeedsDisplay:YES];
    CFRelease(context);
  });
}

}  // namespace
}  // namespace fongmi

@implementation FongMiMpvOpenGLView

- (instancetype)initWithFrame:(NSRect)frame attachment:(const fongmi::NativeViewAttachment&)attachment {
  NSOpenGLPixelFormatAttribute attributes[] = {
    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
    NSOpenGLPFAColorSize, 24,
    NSOpenGLPFAAlphaSize, 8,
    NSOpenGLPFADoubleBuffer,
    NSOpenGLPFAAccelerated,
    NSOpenGLPFANoRecovery,
    0,
  };
  NSOpenGLPixelFormat* format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
  if (!format) return nil;
  self = [super initWithFrame:frame pixelFormat:format];
  if (self) {
    _attachment = attachment;
    _rendererInitialized = NO;
    _rendererShuttingDown = NO;
    self.autoresizingMask = NSViewNotSizable;
    self.wantsBestResolutionOpenGLSurface = YES;
  }
  return self;
}

- (BOOL)isOpaque {
  return YES;
}

- (BOOL)initializeRendererNow {
  if (_rendererInitialized) return YES;
  if (_rendererShuttingDown || !_attachment.initializeRenderer) return NO;
  [[self openGLContext] makeCurrentContext];
  GLint swapInterval = 1;
  [[self openGLContext] setValues:&swapInterval forParameter:NSOpenGLContextParameterSwapInterval];
  std::string error;
  const bool initialized = _attachment.initializeRenderer(
    _attachment.rendererContext,
    fongmi::ResolveOpenGLSymbol,
    nullptr,
    fongmi::RequestDarwinRedraw,
    (__bridge void*)self,
    &error);
  if (!initialized) {
    _rendererError = [NSString stringWithUTF8String:error.empty() ? "libmpv OpenGL 渲染器初始化失败" : error.c_str()];
    return NO;
  }
  _rendererInitialized = YES;
  [self setNeedsDisplay:YES];
  return YES;
}

- (void)prepareOpenGL {
  [super prepareOpenGL];
  [self initializeRendererNow];
}

- (void)reshape {
  [super reshape];
  [[self openGLContext] update];
  [self setNeedsDisplay:YES];
}

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  [[self openGLContext] makeCurrentContext];
  const CGFloat scale = self.window.backingScaleFactor > 0 ? self.window.backingScaleFactor : 1.0;
  const int width = MAX(1, static_cast<int>(NSWidth(self.bounds) * scale));
  const int height = MAX(1, static_cast<int>(NSHeight(self.bounds) * scale));
  glViewport(0, 0, width, height);
  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  if (_rendererInitialized && !_rendererShuttingDown && _attachment.renderFrame) {
    _attachment.renderFrame(_attachment.rendererContext, width, height);
  }
  [[self openGLContext] flushBuffer];
  if (_rendererInitialized && !_rendererShuttingDown && _attachment.reportSwap) {
    _attachment.reportSwap(_attachment.rendererContext);
  }
}

- (void)shutdownRenderer {
  if (_rendererShuttingDown) return;
  _rendererShuttingDown = YES;
  if (_rendererInitialized && _attachment.shutdownRenderer) {
    [[self openGLContext] makeCurrentContext];
    _attachment.shutdownRenderer(_attachment.rendererContext);
  }
  _rendererInitialized = NO;
  [NSOpenGLContext clearCurrentContext];
}

- (NSString*)rendererError {
  return _rendererError ?: @"";
}

- (void)dealloc {
  [self shutdownRenderer];
}

@end

namespace fongmi {

bool NativeViewRenderSupportedDarwin() {
  return true;
}

NativeViewResult AttachNativeViewDarwin(const NativeViewAttachment& attachment) {
  __block NativeViewResult result{false, 0, "macOS 原生视频视图创建失败"};
  void (^attachBlock)(void) = ^{
    NSView* parent = (__bridge NSView*)reinterpret_cast<void*>(attachment.parentHandle);
    if (!parent) {
      result = {false, 0, "Electron NSView 句柄无效"};
      return;
    }
    FongMiMpvOpenGLView* view = [[FongMiMpvOpenGLView alloc]
      initWithFrame:FrameForAttachment(parent, attachment.x, attachment.y, attachment.width, attachment.height)
      attachment:attachment];
    if (!view) {
      result = {false, 0, "无法创建 NSOpenGLView"};
      return;
    }
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
    if (![view initializeRendererNow]) {
      const std::string message([[view rendererError] UTF8String] ?: "libmpv OpenGL 渲染器初始化失败");
      [view removeFromSuperview];
      result = {false, 0, message};
      return;
    }
    const std::uintptr_t retainedHandle = reinterpret_cast<std::uintptr_t>((__bridge_retained void*)view);
    result = {true, retainedHandle, "macOS libmpv OpenGL 视图已挂载"};
  };
  if ([NSThread isMainThread]) attachBlock();
  else dispatch_sync(dispatch_get_main_queue(), attachBlock);
  return result;
}

void DetachNativeViewDarwin(std::uintptr_t viewHandle) {
  if (!viewHandle) return;
  void (^detachBlock)(void) = ^{
    FongMiMpvOpenGLView* view = (__bridge_transfer FongMiMpvOpenGLView*)reinterpret_cast<void*>(viewHandle);
    [view shutdownRenderer];
    [view removeFromSuperview];
  };
  if ([NSThread isMainThread]) detachBlock();
  else dispatch_sync(dispatch_get_main_queue(), detachBlock);
}

void ResizeNativeViewDarwin(std::uintptr_t viewHandle, int x, int y, int width, int height) {
  if (!viewHandle || width <= 0 || height <= 0) return;
  void (^resizeBlock)(void) = ^{
    FongMiMpvOpenGLView* view = (__bridge FongMiMpvOpenGLView*)reinterpret_cast<void*>(viewHandle);
    NSView* parent = view.superview;
    if (!parent) return;
    view.frame = FrameForAttachment(parent, x, y, width, height);
    [[view openGLContext] update];
    [view setNeedsDisplay:YES];
  };
  if ([NSThread isMainThread]) resizeBlock();
  else dispatch_async(dispatch_get_main_queue(), resizeBlock);
}

}  // namespace fongmi
