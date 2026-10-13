import { NextConfig } from 'next';

const nextConfig: NextConfig = {
    cacheComponents: true,
    images: {
        // This is necessary to display images from your local Vendure instance
        dangerouslyAllowLocalIP: true,
        remotePatterns: [
            {
                hostname: 'readonlydemo.vendure.io',
            },
            {
                hostname: 'demo.vendure.io'
            },
            {
                hostname: 'localhost',
                port: '54321'
            },
            {
                hostname: '127.0.0.1',
                port: '54321'
            }
        ],
    },
    experimental: {
        rootParams: true
    }
};

export default nextConfig;