import { registerTool } from "../registry.js";
import { listContactsTool, whoamiTool } from "./identity.js";
import { linkEmailToContactTool } from "./link-email-to-contact.js";
import {
  getThreadTool,
  markReadTool,
  readInboxTool,
  sendMessageTool,
  waitForMessagesTool,
} from "./messaging.js";

registerTool(whoamiTool);
registerTool(listContactsTool);
registerTool(sendMessageTool);
registerTool(readInboxTool);
registerTool(waitForMessagesTool);
registerTool(getThreadTool);
registerTool(markReadTool);
registerTool(linkEmailToContactTool);
