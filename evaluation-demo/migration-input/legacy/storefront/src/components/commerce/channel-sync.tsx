'use client';

import { useEffect } from 'react';
import { getActiveCustomer } from '@/lib/vendure/actions';

/**
 * 频道同步组件
 * 
 * 作用：如果用户处于登录状态但 country_code Cookie 丢失，
 * 自动从用户资料中同步国家码到 Cookie。
 */
export function ChannelSync() {
    useEffect(() => {
        // 检查 Cookie 中是否已有国家码
        const hasCountryCookie = document.cookie.includes('country_code=');
        
        if (!hasCountryCookie) {
            // 如果缺失，尝试从个人资料同步
            syncFromProfile();
        }
    }, []);

    async function syncFromProfile() {
        try {
            // 注意：因为我们是在客户端，需要一个类似 API 的方式获取，
            // 或者直接让服务端在渲染时发现缺失并传递给客户端。
            // 这里我们调用一个 client-side 友好的 fetch
            const resp = await fetch('/api/auth/session-sync');
            if (resp.ok) {
                const data = await resp.json();
                if (data.countryCode) {
                    console.log(`[ChannelSync] Auto-synced country from profile: ${data.countryCode}`);
                    // 页面刷新以应用新频道
                    window.location.reload();
                }
            }
        } catch (e) {
            // Ignore
        }
    }

    return null;
}
