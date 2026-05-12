import { registerTool } from "../registry.js";
import { whoamiTool, listContactsTool } from "./identity.js";

registerTool(whoamiTool);
registerTool(listContactsTool);
