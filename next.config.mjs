/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  outputFileTracingIncludes: {
    "/api/pledges": ["./assets/fonts/NotoSansJP-Regular.ttf"],
  },
}

export default nextConfig
