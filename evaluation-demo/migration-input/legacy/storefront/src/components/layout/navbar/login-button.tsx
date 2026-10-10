'use client'

import { ComponentProps, useTransition } from "react";
import { logoutAction } from "@/app/(shop)/[country]/sign-in/actions";
import { useRouter, useParams } from "next/navigation";

interface LoginButtonProps extends ComponentProps<'button'> {
    isLoggedIn: boolean;
}

export function LoginButton({ isLoggedIn, ...props }: LoginButtonProps) {
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const params = useParams();
    const country = params?.country as string;

    return (
        <button {...props} aria-disabled={isPending}
            onClick={() => {
                if (isLoggedIn) {
                    startTransition(async () => {
                        await logoutAction()
                    })
                } else {
                    const signInPath = country ? `/${country}/sign-in` : '/sign-in';
                    router.push(signInPath);
                }
            }}>
            {isLoggedIn ? 'Sign out' : 'Sign in'}
        </button>
    )
}