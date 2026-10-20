import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "coverage/"] },
  js.configs.recommended,
  {
    rules: {
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
      "no-implicit-coercion": ["error", { allow: ["!!"] }],
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: globals.browser },
  },
];
