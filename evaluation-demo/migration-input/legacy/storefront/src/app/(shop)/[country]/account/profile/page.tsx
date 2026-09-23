import type { Metadata } from 'next';
import { getActiveCustomer, getAvailableCountries } from '@/lib/vendure/actions';

export const metadata: Metadata = {
    title: 'Profile',
};
import { ChangePasswordForm } from './change-password-form';
import { EditProfileForm } from './edit-profile-form';
import { EditEmailForm } from './edit-email-form';
import { SettingsForm } from '@/components/commerce/settings-form';
import { cookies } from 'next/headers';

export default async function ProfilePage(_props: PageProps<'/account/profile'>) {
    const customer = await getActiveCustomer();
    const availableCountries = await getAvailableCountries();
    const cookieStore = await cookies();
    const currentLanguage = cookieStore.get('language_code')?.value || 'en';

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Profile</h1>
                <p className="text-muted-foreground mt-2">
                    Manage your account information and preferences
                </p>
            </div>

            <SettingsForm 
                customer={customer} 
                currentLanguage={currentLanguage} 
                availableCountries={availableCountries} 
            />

            <EditProfileForm customer={customer} />

            <EditEmailForm currentEmail={customer?.emailAddress || ''} />

            <ChangePasswordForm />
        </div>
    );
}
