import { buildSupervisor } from "../../../scripts/build-supervisor.mjs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
buildSupervisor(root, "agy-supervisor");
