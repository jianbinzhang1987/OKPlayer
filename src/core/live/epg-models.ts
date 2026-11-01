export interface EpgChannelDefinition {
  id: string;
  names: string[];
  icon?: string;
}

export interface EpgProgramme {
  id: string;
  channelId: string;
  startAt: number;
  endAt: number;
  title: string;
  subtitle?: string;
  description?: string;
  categories: string[];
  icon?: string;
}

export type EpgMatchMethod = "manual" | "tvg-id" | "tvg-name" | "channel-name" | "normalized-name";

export interface LiveEpgMapping {
  sourceId: string;
  liveChannelId: string;
  epgChannelId: string;
  epgChannelName?: string;
  updatedAt: number;
}

export interface LiveChannelEpg {
  liveChannelId: string;
  epgChannelId?: string;
  matchMethod?: EpgMatchMethod;
  confidence: number;
  current?: EpgProgramme;
  next?: EpgProgramme;
  schedule: EpgProgramme[];
}

export interface LiveEpgGuide {
  sourceId: string;
  loadedAt: number;
  expiresAt: number;
  epgSourceCount: number;
  epgChannelCount: number;
  programmeCount: number;
  matchedChannelCount: number;
  channels: Record<string, LiveChannelEpg>;
  epgChannels: EpgChannelDefinition[];
  warnings: string[];
}

export interface ParsedXmlTv {
  channels: EpgChannelDefinition[];
  programmes: EpgProgramme[];
}
