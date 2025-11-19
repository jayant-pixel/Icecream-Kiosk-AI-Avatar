import nextConfig from "eslint-config-next";
import nextTypescriptConfig from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextConfig,
  ...nextTypescriptConfig,
  {
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];

export default eslintConfig;
