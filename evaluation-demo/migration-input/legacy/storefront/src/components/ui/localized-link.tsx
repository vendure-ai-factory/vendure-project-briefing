'use client'

import Link, { LinkProps } from 'next/link';
import { useParams } from 'next/navigation';
import { ReactNode } from 'react';

interface LocalizedLinkProps extends LinkProps {
    children: ReactNode;
    className?: string;
    href: string;
    countryCode?: string;
}

/**
 * A wrapper around next/link that automatically prepends the current [country] segment
 * to internal URLs.
 */
export function LocalizedLink({ href, children, countryCode: propsCountryCode, ...props }: LocalizedLinkProps) {
    const params = useParams();
    const country = propsCountryCode || (params?.country as string);

    // Only localize internal absolute-path links
    const isInternal = href.startsWith('/') && !href.startsWith('//');
    
    let localizedHref = href;
    if (isInternal && country) {
        // Avoid double-prefixing if the href already starts with /[country]
        const prefix = `/${country}`;
        if (!href.startsWith(prefix)) {
            localizedHref = `${prefix}${href === '/' ? '' : href}`;
        }
    }

    return (
        <Link href={localizedHref} {...props}>
            {children}
        </Link>
    );
}
