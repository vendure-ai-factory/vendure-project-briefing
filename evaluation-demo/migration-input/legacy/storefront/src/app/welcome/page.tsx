'use client';

import { useState } from 'react';
import { useTransition } from 'react';
import { setCountryAndLanguage } from './actions';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Globe, MapPin } from 'lucide-react';
import { toast } from 'sonner';

import { AVAILABLE_COUNTRIES } from '@/lib/vendure/api';

const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'zh', name: '中文' },
];

export default function WelcomePage() {
    const [country, setCountry] = useState<string>('');
    const [language, setLanguage] = useState<string>('');
    const [isPending, startTransition] = useTransition();

    const handleSubmit = (formData: FormData) => {
        if (!country || !language) {
            toast.error('Please select both a country and a language.');
            return;
        }

        // The hidden inputs below ensure formData contains 'country' and 'language'

        startTransition(async () => {
            try {
                await setCountryAndLanguage(formData);
            } catch (error) {
                toast.error('Something went wrong. Please try again.');
                console.error(error);
            }
        });
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-neutral-950 p-4">
            <Card className="w-full max-w-md shadow-2xl border-none bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm">
                <CardHeader className="text-center space-y-2">
                    <div className="mx-auto w-12 h-12 bg-black dark:bg-white rounded-full flex items-center justify-center mb-4">
                        <Globe className="w-6 h-6 text-white dark:text-black" />
                    </div>
                    <CardTitle className="text-3xl font-bold tracking-tight">Welcome</CardTitle>
                    <CardDescription className="text-base text-gray-500 dark:text-gray-400">
                        Please select your region and language to continue.
                    </CardDescription>
                </CardHeader>
                <form action={handleSubmit}>
                    {/* Hidden inputs to pass state to Server Action via FormData */}
                    <input type="hidden" name="country" value={country} />
                    <input type="hidden" name="language" value={language} />

                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2">
                                <MapPin className="w-4 h-4" /> Country / Region
                            </label>
                            <Select onValueChange={setCountry} required>
                                <SelectTrigger className="w-full h-12">
                                    <SelectValue placeholder="Select your country" />
                                </SelectTrigger>
                                <SelectContent>
                                    {AVAILABLE_COUNTRIES.map((c) => (
                                        <SelectItem key={c.code} value={c.code}>
                                            <span className="flex items-center gap-2">
                                                <span className="text-lg">{c.flag}</span>
                                                <span>{c.name} ({c.currency})</span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2">
                                <Globe className="w-4 h-4" /> Language
                            </label>
                            <Select onValueChange={setLanguage} required>
                                <SelectTrigger className="w-full h-12">
                                    <SelectValue placeholder="Select your language" />
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
                    <CardFooter>
                        <Button
                            className="w-full h-12 text-lg font-medium transition-all hover:scale-[1.02]"
                            size="lg"
                            type="submit"
                            disabled={isPending || !country || !language}
                        >
                            {isPending ? 'Setting up...' : 'Enter Shop'}
                        </Button>
                    </CardFooter>
                </form>
            </Card>

            {/* Background decoration */}
            <div className="fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-sky-100 via-transparent to-transparent opacity-40 dark:from-sky-900/20" />
        </div>
    );
}
