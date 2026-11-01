import type { HeadersMap } from "../models.ts";

export type LiveSourceFormat = "m3u" | "txt" | "json" | "embedded";

export interface LiveCatchup {
  type?: string;
  regex?: string;
  source?: string;
  replace?: string;
}

export interface LiveSourceDefinition {
  id: string;
  name: string;
  url?: string;
  api?: string;
  ext?: string;
  jar?: string;
  click?: string;
  logo?: string;
  epgUrls: string[];
  ua?: string;
  origin?: string;
  referer?: string;
  timeZone?: string;
  timeout?: number;
  header: HeadersMap;
  catchup?: LiveCatchup;
  groups?: unknown[];
  boot?: boolean;
  revealProtectedGroups?: boolean;
}

export type LiveLineHealthState = "unknown" | "available" | "degraded" | "unavailable";

export interface LiveLineHealth {
  state: LiveLineHealthState;
  score: number;
  checkedAt: number;
  latencyMs?: number;
  resolution?: string;
  bandwidthKbps?: number;
  segmentVerified?: boolean;
  playbackSuccessCount?: number;
  playbackFailureCount?: number;
  stablePlaybackSeconds?: number;
  bufferingCount?: number;
  bufferingDurationMs?: number;
  failoverSuccessCount?: number;
  failoverFailureCount?: number;
  averageStartupMs?: number;
  lastPlaybackAt?: number;
  reason?: string;
}

export type LivePlaybackFeedbackKind = "started" | "stable" | "buffering" | "failure" | "failover-success" | "failover-failure";

export interface LivePlaybackFeedback {
  sourceId: string;
  channelId: string;
  lineId: string;
  lineName?: string;
  kind: LivePlaybackFeedbackKind;
  startupMs?: number;
  playedSeconds?: number;
  bufferingCount?: number;
  bufferingDurationMs?: number;
  reason?: string;
  occurredAt: number;
}

export interface LiveLineQualityRecord {
  sourceId: string;
  channelId: string;
  lineId: string;
  lineName: string;
  state: LiveLineHealthState;
  score: number;
  probeState: LiveLineHealthState;
  probeScore: number;
  probeLatencyMs?: number;
  resolution?: string;
  bandwidthKbps?: number;
  segmentVerified?: boolean;
  probeReason?: string;
  lastProbeAt: number;
  playbackSuccessCount: number;
  playbackFailureCount: number;
  stablePlaybackSeconds: number;
  bufferingCount: number;
  bufferingDurationMs: number;
  failoverSuccessCount: number;
  failoverFailureCount: number;
  startupSamples: number;
  startupTotalMs: number;
  lastStartupMs?: number;
  lastPlaybackAt: number;
  lastFailureAt: number;
  lastFailureReason?: string;
  updatedAt: number;
}

export interface LiveLine {
  id: string;
  name: string;
  url: string;
  headers: HeadersMap;
  format?: string;
  parse: boolean;
  click?: string;
  priority: number;
  health?: LiveLineHealth;
}

export interface LiveChannel {
  id: string;
  sourceId: string;
  groupId: string;
  name: string;
  number?: string;
  logo?: string;
  epgUrl?: string;
  tvgId?: string;
  tvgName?: string;
  lines: LiveLine[];
  catchup?: LiveCatchup;
}

export interface LiveGroup {
  id: string;
  sourceId: string;
  name: string;
  passwordProtected: boolean;
  channels: LiveChannel[];
}

export interface LiveSource {
  id: string;
  name: string;
  sourceUrl?: string;
  format: LiveSourceFormat;
  epgUrls: string[];
  logoTemplate?: string;
  headers: HeadersMap;
  timeZone?: string;
  boot: boolean;
  groups: LiveGroup[];
  loadedAt: number;
}

export interface LiveSourceSummary {
  id: string;
  name: string;
  sourceUrl?: string;
  format?: LiveSourceFormat;
  boot: boolean;
  loaded: boolean;
  groupCount: number;
  channelCount: number;
  lineCount: number;
  loadedAt?: number;
  error?: string;
}

export interface LiveFavoriteRecord {
  sourceId: string;
  channelId: string;
  channelName: string;
  logo?: string;
  createdAt: number;
}

export interface LiveRecentRecord {
  sourceId: string;
  channelId: string;
  channelName: string;
  lineId?: string;
  watchedAt: number;
}

export interface LiveCatchupHistoryRecord {
  sourceId: string;
  channelId: string;
  programmeStartAt: number;
  programmeEndAt: number;
  programmeTitle: string;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
}
