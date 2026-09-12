import { bootstrap, DefaultLogger, LogLevel, CustomerService, RequestContextService, ChannelService, Customer, User, PasswordCipher, TransactionalConnection, NativeAuthenticationMethod } from '@vendure/core';
import { config } from '../src/vendure-config';

// Reduce logging
config.logger = new DefaultLogger({ level: LogLevel.Error });

const TEST_ACCOUNTS = [
    { email: 'test1@example.com', password: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD', firstName: 'Test', lastName: 'User1' },
    { email: 'test2@example.com', password: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD', firstName: 'Test', lastName: 'User2' },
    { email: 'test3@example.com', password: process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD', firstName: 'Test', lastName: 'User3' },
];

async function run() {
    console.log('>>> Bootstrapping Vendure for Mock Account Creation...');

    let app: any;
    let port = 3005; // Use a much higher port to avoid common conflicts
    const maxRetries = 10;

    for (let i = 0; i < maxRetries; i++) {
        try {
            config.apiOptions.port = port + i;
            app = await bootstrap(config);
            console.log(`>>> Successfully bootstrapped on port ${config.apiOptions.port}`);
            break;
        } catch (err: any) {
            if (err.code === 'EADDRINUSE') {
                console.log(`>>> Port ${config.apiOptions.port} in use, trying next...`);
                continue;
            }
            throw err;
        }
    }

    if (!app) {
        throw new Error('Failed to bootstrap Vendure: No available ports found.');
    }

    const customerService = app.get(CustomerService);
    const channelService = app.get(ChannelService);
    const reqCtxService = app.get(RequestContextService);
    const connection = app.get(TransactionalConnection);
    const passwordCipher = app.get(PasswordCipher);

    const channel = await channelService.getDefaultChannel();
    const ctx = await reqCtxService.create({ apiType: 'shop', channelOrToken: channel });

    for (const account of TEST_ACCOUNTS) {
        console.log(`>>> Processing account: ${account.email}...`);

        let customer = await connection.getRepository(ctx, Customer).findOne({
            where: { emailAddress: account.email },
            relations: ['user', 'user.authenticationMethods']
        });

        if (!customer) {
            const customerResult = await customerService.create(ctx, {
                emailAddress: account.email,
                firstName: account.firstName,
                lastName: account.lastName,
            });

            if ((customerResult as any).errorCode) {
                console.error(`❌ Failed to create customer ${account.email}:`, customerResult);
                continue;
            }
            // Reload with relations
            customer = await connection.getRepository(ctx, Customer).findOne({
                where: { emailAddress: account.email },
                relations: ['user', 'user.authenticationMethods']
            }) as Customer;
        }

        if (customer && customer.user) {
            console.log(`>>> Setting password and verifying for ${account.email}...`);

            // 1. Mark user as verified
            await connection.getRepository(ctx, User).update(customer.user.id, { verified: true });

            // 2. Update NativeAuthenticationMethod
            const nativeAuthMethod = customer.user.authenticationMethods.find((m: any) => m instanceof NativeAuthenticationMethod) as NativeAuthenticationMethod;

            if (nativeAuthMethod) {
                const passwordHash = await passwordCipher.hash(account.password);
                await connection.getRepository(ctx, NativeAuthenticationMethod).update(nativeAuthMethod.id, {
                    passwordHash: passwordHash
                });
                console.log(`✅ Account ${account.email} processed and verified.`);
            } else {
                console.error(`❌ No NativeAuthenticationMethod found for ${account.email}`);
            }
        }
    }

    console.log('>>> All accounts processed.');
    await app.close();
    process.exit(0);
}

run().catch(err => {
    console.error('❌ Script failed:', err);
    process.exit(1);
});
