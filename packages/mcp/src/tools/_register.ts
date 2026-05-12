import { registerTool } from "../registry.js";
import { whoamiTool, listContactsTool } from "./identity.js";
import {
  sendMessageTool,
  readInboxTool,
  waitForMessagesTool,
  getThreadTool,
  markReadTool
} from "./messaging.js";

registerTool(whoamiTool);
registerTool(listContactsTool);
registerTool(sendMessageTool);
registerTool(readInboxTool);
registerTool(waitForMessagesTool);
registerTool(getThreadTool);
registerTool(markReadTool);
