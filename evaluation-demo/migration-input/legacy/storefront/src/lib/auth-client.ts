import { AUTH_TOKEN_COOKIE } from './auth-shared';

export function getAuthTokenClient(): string | undefined {
    if (typeof document === 'undefined') return undefined;

    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === AUTH_TOKEN_COOKIE) {
            return decodeURIComponent(value);
        }
    }
    return undefined;
}
