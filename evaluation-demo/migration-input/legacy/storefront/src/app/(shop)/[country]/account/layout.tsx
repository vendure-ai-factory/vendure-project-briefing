import type { Metadata } from 'next';
import Link from 'next/link';
import { Package, User, MapPin, Ruler, Wallet } from 'lucide-react';
import { noIndexRobots } from '@/lib/metadata';

export const metadata: Metadata = {
    robots: noIndexRobots(),
};

const navItems = [
    { href: '/account/orders', label: 'Orders', icon: Package },
    { href: '/account/wallet', label: '💰 My Wallet', icon: Wallet },
    { href: '/account/addresses', label: 'Addresses', icon: MapPin },
    { href: '/account/nail-sizes', label: '💅 My Nail Sizes', icon: Ruler },
    { href: '/account/profile', label: 'Profile', icon: User },
];

export default async function AccountLayout({ 
    children,
    params
}: { 
    children: React.ReactNode;
    params: Promise<{ country: string }>;
}) {
    const { country } = await params;

    return (
        <div className="container mx-auto px-4 py-30">
            <div className="flex gap-8">
                <aside className="w-64 shrink-0">
                    <nav className="space-y-1">
                        {navItems.map((item) => (
                            <Link
                                key={item.href}
                                href={`/${country}${item.href}`}
                                className="flex items-center gap-3 px-4 py-2 text-sm font-medium rounded-md hover:bg-gray-100 transition-colors"
                            >

                                <item.icon className="h-5 w-5" />
                                {item.label}
                            </Link>
                        ))}
                    </nav>
                </aside>
                <main className="flex-1">
                    {children}
                </main>
            </div>
        </div>
    );
}
