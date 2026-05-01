import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const isProd = process.env.NODE_ENV === "production"
const internalHost = process.env.TAURI_DEV_HOST || "localhost"
const withNextIntl = createNextIntlPlugin({
  requestConfig: "./src/i18n/request.ts",
  experimental: {
    messages: {
      path: "./src/i18n/messages",
      format: "json",
      locales: [
        "en",
        "zh-CN",
        "zh-TW",
        "ja",
        "ko",
        "es",
        "de",
        "fr",
        "pt",
        "ar",
      ],
      precompile: true,
    },
  },
})

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  async webpack(config) {
    if (process.env.OTOOLS_PLUGIN === "1") {
      const { createOtoolsAliasMap } = await import("otools-plugin-sdk/aliases")
      config.resolve ??= {}
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        ...createOtoolsAliasMap(),
      }
    }
    return config
  },
}

export default withNextIntl(nextConfig)
