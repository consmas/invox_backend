import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  { ignores: [".local-backups/**", ".next/**", ".next-smoke/**", "node_modules/**", "next-env.d.ts", "out/**", "coverage/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // now override or disable the rules you want
  {
    rules: {
      // allow any for now (so @typescript-eslint/no-explicit-any won’t error out)
      "@typescript-eslint/no-explicit-any": "off",

      // unused vars → warn (won’t fail your build)
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",      // ignore _prefixed args
        varsIgnorePattern: "^_",      // ignore _prefixed vars
      }],

      // disable Next.js’s “no raw <a>” rule
      "@next/next/no-html-link-for-pages": "off",
    }
  }
];

export default eslintConfig;

