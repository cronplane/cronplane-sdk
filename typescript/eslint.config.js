import { defineConfig } from "eslint/config";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules", "coverage"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    // Tests read and write only in the temporary directories they make.
    files: ["test/**"],
    rules: { "security/detect-non-literal-fs-filename": "off", "security/detect-object-injection": "off" },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
