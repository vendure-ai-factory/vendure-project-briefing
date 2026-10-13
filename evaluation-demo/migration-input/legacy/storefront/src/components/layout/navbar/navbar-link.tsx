'use client';

import {useSelectedLayoutSegment} from 'next/navigation';
import {ComponentProps} from 'react';
import Link from 'next/link';
import {
    NavigationMenuLink,
    navigationMenuTriggerStyle,
} from '@/components/ui/navigation-menu';
import {cn} from '@/lib/utils';
import { LocalizedLink } from '@/components/ui/localized-link';

export function NavbarLink({href, ...rest}: { href: string } & ComponentProps<typeof Link>) {
    const selectedLayoutSegment = useSelectedLayoutSegment();
    // In [country] mode, the segment we care about might be different.
    // For now, we'll keep it simple. LocalizedLink handles the prefixing.
    const isActive = false; 

    return (
        <NavigationMenuLink asChild active={isActive}>
            <LocalizedLink
                aria-current={isActive ? 'page' : undefined}
                className={cn(navigationMenuTriggerStyle())}
                href={href}
                {...rest}
            >
                {rest.children}
            </LocalizedLink>
        </NavigationMenuLink>
    );
}