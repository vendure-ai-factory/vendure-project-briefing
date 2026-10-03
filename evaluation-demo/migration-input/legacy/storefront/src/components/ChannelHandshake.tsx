'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getSession, updateActiveChannel, COUNTRY_CHANNEL_MAP } from '@/lib/vendure/api';
import { Button } from '@/components/ui/button';
import { Globe, ArrowRight, X } from 'lucide-react';
import { toast } from 'sonner';

export function ChannelHandshake() {
    const [isVisible, setIsVisible] = useState(false);
    const [targetChannel, setTargetChannel] = useState<{ code: string; token: string; authToken?: string } | null>(null);
    const [isPending, startTransition] = useTransition();
    const pathname = usePathname();
    const router = useRouter();

    useEffect(() => {
        const checkSession = async () => {
            const segments = pathname.split('/').filter(Boolean);
            const countryFromPath = segments[0]?.toLowerCase();
            const validCountries = ['de', 'at', 'hu', 'nl', 'fr', 'es', 'it'];
            
            if (!countryFromPath || !validCountries.includes(countryFromPath)) {
                setIsVisible(false);
                return;
            }

            let session;
            try {
                session = await getSession();
            } catch (e) {
                console.warn('[Handshake] getSession failed. Retrying...', e);
                setTimeout(checkSession, 2000);
                return;
            }

            const tokenMatch = document.cookie.match(/vendure-auth-token=([^;]+)/);
            const expectedToken = COUNTRY_CHANNEL_MAP[countryFromPath];
            const userAuthToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : undefined;
            
            const homeMatch = document.cookie.match(/home_country=([^;]+)/);
            const cookieHomeCountry = homeMatch ? decodeURIComponent(homeMatch[1]) : undefined;
            const profileCountryCode = session?.activeCustomer?.customFields?.countryCode;
            const countryMatch = document.cookie.match(/country_code=([^;]+)/);
            const cookieCountryCode = countryMatch ? decodeURIComponent(countryMatch[1]) : undefined;

            const effectiveHomeCountry = (cookieHomeCountry || profileCountryCode || cookieCountryCode || '');
            const currentSessionToken = session?.activeSessionChannelToken || '';

            // CRITICAL FIX: Everything to lowerCase and explicit Boolean check
            const pathCode = countryFromPath.toLowerCase();
            const homeCode = String(effectiveHomeCountry).toLowerCase();
            const sToken = currentSessionToken.toLowerCase();
            const eToken = String(expectedToken).toLowerCase();

            const needsHandshake = (sToken !== eToken) || (homeCode !== '' && homeCode !== pathCode);

            if (needsHandshake) {
                console.log(`[Handshake] Mismatch. Path=${pathCode} vs Home=${homeCode}. SessionToken=${sToken} vs Expected=${eToken}`);
                setTargetChannel({ code: countryFromPath.toUpperCase(), token: expectedToken, authToken: userAuthToken });
                setIsVisible(true);
            } else {
                setIsVisible(false);
            }
        };

        checkSession();
    }, [pathname]);

    const handleSwitch = () => {
        if (!targetChannel) return;
        startTransition(async () => {
            try {
                const result = await updateActiveChannel(targetChannel.token, targetChannel.authToken);
                if (result.data.setActiveChannel === true) {
                    const cookieOptions = `; path=/; max-age=31536000; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
                    document.cookie = `home_country=${targetChannel.code}${cookieOptions}`;
                    document.cookie = `country_code=${targetChannel.code}${cookieOptions}`;
                    toast.success(`已切换至 ${targetChannel.code} 频道`);
                    setIsVisible(false);
                    router.refresh();
                } else {
                    toast.error('切换失败');
                }
            } catch (error) {
                toast.error('系统繁忙');
            }
        });
    };

    return (
        <>{isVisible && targetChannel && (
            <div className="fixed bottom-4 right-4 w-96 z-[100] animate-in slide-in-from-bottom-5">
                <div className="bg-card border shadow-2xl rounded-xl p-4 flex flex-col gap-4">
                    <div className="flex items-start gap-4">
                        <Globe className="w-5 h-5 text-primary" />
                        <div>
                            <h3 className="font-semibold text-sm">检测到地区切换</h3>
                            <p className="text-muted-foreground text-xs mt-1">您正以其他地区身份访问 {targetChannel.code} 站。</p>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setIsVisible(false)}>稍后</Button>
                        <Button size="sm" onClick={handleSwitch} disabled={isPending}>{isPending ? '切换中...' : '确认切换'}</Button>
                    </div>
                </div>
            </div>
        )}</>
    );
}
