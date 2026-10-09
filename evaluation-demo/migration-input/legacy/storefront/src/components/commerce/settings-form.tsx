'use client';

import { useState, useTransition } from 'react';
import { updatePreferences } from '@/app/(shop)/[country]/account/profile/actions';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Globe, MapPin, Calendar } from 'lucide-react';
import { toast } from 'sonner';

const COUNTRY_INFO: Record<string, { name: string; flag: string; currency: string }> = {
    'DE': { name: 'Germany', flag: '🇩🇪', currency: 'EUR' },
    'AT': { name: 'Austria', flag: '🇦🇹', currency: 'EUR' },
    'HU': { name: 'Hungary', flag: '🇭🇺', currency: 'HUF' },
    'OTHER': { name: 'Other Country', flag: '🌍', currency: 'EUR' },
};

const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'zh', name: '中文' },
];

interface SettingsFormProps {
    customer: any;
    currentLanguage?: string;
    availableCountries: string[];
}

export function SettingsForm({ customer, currentLanguage, availableCountries }: SettingsFormProps) {
    const [country, setCountry] = useState<string>((customer?.customFields as any)?.countryCode || 'DE');
    const [language, setLanguage] = useState<string>(currentLanguage || 'en');
    const [isPending, startTransition] = useTransition();

    const lastSwitch = (customer?.customFields as any)?.lastCountrySwitchAt;

    let canSwitch = true;
    let nextSwitchDate: Date | null = null;

    if (lastSwitch) {
        const lastDate = new Date(lastSwitch);
        const nextDate = new Date(lastDate.getTime() + 30 * 1000); // 30 seconds cooldown
        const now = new Date();
        if (now < nextDate) {
            canSwitch = false;
            nextSwitchDate = nextDate;
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const originalCountry = (customer?.customFields as any)?.countryCode || 'DE';
        if (country !== originalCountry && !canSwitch) {
            toast.error(`Country change is restricted. You can change it again on ${nextSwitchDate?.toLocaleDateString()}.`);
            return;
        }

        const formData = new FormData();
        formData.append('country', country);
        formData.append('language', language);

        startTransition(async () => {
            const result = await updatePreferences(formData);
            if (result?.error) {
                toast.error(result.error);
            } else {
                toast.success('Preferences updated successfully');
            }
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-xl flex items-center gap-2">
                    <Globe className="w-5 h-5" /> Preferences
                </CardTitle>
                <CardDescription>
                    Your default region and language settings. Default country affects currency and shipping.
                </CardDescription>
            </CardHeader>
            <form onSubmit={handleSubmit}>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium flex items-center gap-2">
                            <MapPin className="w-4 h-4" /> Default Country / Region
                        </label>
                        <Select value={country} onValueChange={setCountry} disabled={isPending}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select country" />
                            </SelectTrigger>
                            <SelectContent>
                                {availableCountries.map((code) => {
                                    const info = COUNTRY_INFO[code] || { name: code, flag: '📍', currency: 'EUR' };
                                    return (
                                        <SelectItem key={code} value={code}>
                                            <span className="flex items-center gap-2">
                                                <span>{info.flag}</span>
                                                <span>{info.name} ({info.currency})</span>
                                            </span>
                                        </SelectItem>
                                    );
                                })}
                            </SelectContent>
                        </Select>
                        {lastSwitch && !canSwitch && (
                            <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                                <Calendar className="w-3 h-3" />
                                Country change cooldown active. Next change available on: {nextSwitchDate ? `${nextSwitchDate.getFullYear()}-${String(nextSwitchDate.getMonth() + 1).padStart(2, '0')}-${String(nextSwitchDate.getDate()).padStart(2, '0')}` : ''}
                            </p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium flex items-center gap-2">
                            <Globe className="w-4 h-4" /> Default Language
                        </label>
                        <Select value={language} onValueChange={setLanguage} disabled={isPending}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select language" />
                            </SelectTrigger>
                            <SelectContent>
                                {LANGUAGES.map((l) => (
                                    <SelectItem key={l.code} value={l.code}>
                                        {l.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
                <CardFooter className="bg-muted/30 py-3">
                    <Button type="submit" disabled={isPending}>
                        {isPending ? 'Saving...' : 'Save Preferences'}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}
