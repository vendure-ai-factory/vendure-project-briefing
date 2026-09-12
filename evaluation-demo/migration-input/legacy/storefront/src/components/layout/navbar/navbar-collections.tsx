import { cacheLife } from 'next/cache';
import { getTopCollections } from '@/lib/vendure/cached';
import {
    NavigationMenu,
    NavigationMenuList,
    NavigationMenuItem,
} from '@/components/ui/navigation-menu';
import { NavbarLink } from '@/components/layout/navbar/navbar-link';

import { cookies } from "next/headers";

export interface NavbarCollectionsProps {
    countryCode?: string;
}

async function NavbarCollectionsContent({ countryCode }: { countryCode?: string }) {
    "use cache";
    cacheLife('days');

    const collections = await getTopCollections(countryCode);

    return (
        <NavigationMenu>
            <NavigationMenuList>
                {collections.map((collection) => (
                    <NavigationMenuItem key={collection.slug}>
                        <NavbarLink href={`/collection/${collection.slug}`}>
                            {collection.name}
                        </NavbarLink>
                    </NavigationMenuItem>
                ))}
            </NavigationMenuList>
        </NavigationMenu>
    );
}

export async function NavbarCollections({ countryCode }: { countryCode?: string }) {
    let finalCountryCode = countryCode;

    if (!finalCountryCode) {
        const cookieStore = await cookies();
        finalCountryCode = cookieStore.get('country_code')?.value;
    }

    return <NavbarCollectionsContent countryCode={finalCountryCode} />;
}
