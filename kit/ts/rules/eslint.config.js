// The rules of every TypeScript action, whatever its own configuration says
// (the kit passes this file to ESLint with --config). The TypeScript
// configuration is the kit's too: its path comes in CRONPLANE_KIT_TSCONFIG.
import { defineConfig } from "eslint/config";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

const project = process.env.CRONPLANE_KIT_TSCONFIG;
export default defineConfig(
  // `.cronplane`: the runs `cronplane run` keeps in the folder of the action.
  { ignores: ["**/node_modules", "**/coverage", "**/.cronplane"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  { languageOptions: { parserOptions: { project } } },
);
