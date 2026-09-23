import { redirect } from 'next/navigation';

export default async function AccountPage({ params }: { params: Promise<{ country: string }> }) {
    const { country } = await params;
    redirect(`/${country}/account/profile`);
}
