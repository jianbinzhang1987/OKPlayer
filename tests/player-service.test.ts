import test from "node:test";
import assert from "node:assert/strict";
import { PlayerService } from "../src/core/player-service.ts";

class MockPlayer {
  commands: unknown[] = [];
  listeners = new Map<string, (value: unknown) => void>();
  getIpcPath() { return "mock.sock"; }
  on(event: string, callback: (value: unknown) => void) { this.listeners.set(event, callback); }
  async start() {}
  async load(url: string, headers: Record<string,string>) { this.commands.push({url, headers}); }
  async release() {}
  pause(){ this.commands.push("pause"); }
  play(){ this.commands.push("play"); }
  stop(){ this.commands.push("stop"); }
  seek(value:number){ this.commands.push(value); }
  setSpeed(value:number){ this.commands.push({ speed: value }); }
  setVolume(value:number){ this.commands.push({ volume: value }); }
  setMuted(value:boolean){ this.commands.push({ muted: value }); }
}

test("player service opens media through mpv abstraction", async () => {
  const mock = new MockPlayer();
  const service = new PlayerService(mock as any);
  const result = await service.open("https://demo/a.m3u8", {Referer:"demo"});
  assert.equal(result.status, "started");
  assert.deepEqual(mock.commands[0], {url:"https://demo/a.m3u8", headers:{Referer:"demo"}});
  const states: unknown[] = [];
  service.onState((state) => states.push(state));
  mock.listeners.get("time-pos")?.(42);
  mock.listeners.get("duration")?.(100);
  await service.setSpeed(1.5);
  await service.setVolume(65);
  await service.setMuted(true);
  assert.deepEqual(service.getState(), { position: 42, duration: 100, paused: false, stopped: false, speed: 1.5, volume: 65, muted: true });
  mock.listeners.get("volume")?.(72);
  mock.listeners.get("mute")?.(false);
  assert.equal(service.getState().volume, 72);
  assert.equal(service.getState().muted, false);
  assert.equal(states.length >= 3, true);
});
