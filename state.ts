import type { ChannelID, VideoID } from "./util.ts";

export type State = {
  subscribing: ChannelID[],
  subscribed: ChannelID[],
  downloading: VideoID[],
};
