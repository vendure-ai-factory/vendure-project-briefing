
import { bootstrapWorker, RequestContextService, InternalBackendService, TransactionalConnection, User } from '@vendure/core';
import { config } from '../src/vendure-config';

async function resetPasswords() {
    const { app } = await bootstrapWorker(config);
    const connection = app.get(TransactionalConnection);
    // Note: We need to use the native connection to bypass some service logic if needed,
    // but better to use Bcrypt or similar if we can. 
    // Actually, Vendure has a PasswordCipher.
    const { PasswordCipher } = require('@vendure/core/dist/config/password-cipher/password-cipher');
    const { BcryptPasswordCipher } = require('@vendure/core/dist/config/password-cipher/bcrypt-password-cipher');
    const cipher = new BcryptPasswordCipher();
    const configuredPassword = process.env.EVALUATION_TEST_PASSWORD;
    if (!configuredPassword) throw new Error('Set EVALUATION_TEST_PASSWORD before resetting test passwords.');
    const hashedPassword = await cipher.hash(configuredPassword);

    const emails = ['test1@example.com', 'test2@example.com', 'test3@example.com'];

    for (const email of emails) {
        console.log(`Resetting password for ${email}...`);
        const user = await connection.rawConnection.getRepository(User).findOne({ where: { identifier: email } });
        if (user) {
            user.passwordHash = hashedPassword;
            await connection.rawConnection.getRepository(User).save(user);
            console.log(`Success for ${email}`);
        } else {
            console.log(`User ${email} not found.`);
        }
    }

    await app.close();
    process.exit(0);
}

resetPasswords().catch(err => {
    console.error(err);
    process.exit(1);
});
