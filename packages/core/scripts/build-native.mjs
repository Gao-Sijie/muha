import { fileURLToPath } from "node:url";
import { buildSupervisor } from "../../../scripts/build-supervisor.mjs";
buildSupervisor(fileURLToPath(new URL("../", import.meta.url)), "acp-supervisor");
