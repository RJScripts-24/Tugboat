import { Module } from "@nestjs/common";

import { AgentCoreModule } from "../agent-core/agent-core.module";
import { ChannelsModule } from "../channels/channels.module";
import { VoiceController } from "./voice.controller";

/**
 * The public face of a real call: the TwiML and status webhooks Twilio drives
 * while a customer is on the line (D-144). The adapter that places the call
 * lives in `ChannelsModule`; the executor that settles its outcome lives in
 * `AgentCoreModule`; this module only joins the two to the network.
 */
@Module({
  imports: [ChannelsModule, AgentCoreModule],
  controllers: [VoiceController],
})
export class VoiceModule {}
