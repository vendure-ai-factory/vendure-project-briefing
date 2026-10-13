import { User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LocalizedLink } from '@/components/ui/localized-link';
import { LoginButton } from "@/components/layout/navbar/login-button";
import { getActiveCustomer } from "@/lib/vendure/actions";


export async function NavbarUser() {
    const customer = await getActiveCustomer().catch(() => null);

    if (!customer) {
        return (
            <Button variant="ghost" asChild>
                <LoginButton isLoggedIn={false} />
            </Button>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost">
                    <User className="h-5 w-5" />
                    Hi, {customer.firstName}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
                <DropdownMenuItem asChild>
                    <LocalizedLink href="/account/profile">个人资料</LocalizedLink>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <LocalizedLink href="/account/orders">我的订单</LocalizedLink>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <LocalizedLink href="/account/wallet">💰 我的钱包</LocalizedLink>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <LocalizedLink href="/account/referral">🎁 推荐有奖</LocalizedLink>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <LocalizedLink href="/vendor/dashboard">🎨 设计师中心</LocalizedLink>
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <LoginButton isLoggedIn={true} />
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
