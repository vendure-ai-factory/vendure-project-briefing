import { bootstrap, RequestContext, ProductService, ProductVariantService, CustomerService, OrderService, ChannelService, LanguageCode, RequestContextService, AuthService, TransactionalConnection, CountryService, User, NativeAuthenticationMethod, PasswordCipher, AuthenticationMethod, CurrencyCode, SessionService, Order, Address } from '@vendure/core';
import { config } from '../src/vendure-config';
import { MultiCountryPlugin } from '../src/plugins/multi-country/multi-country.plugin';
import { PriceUpdaterService } from '../src/plugins/multi-country/services/price-updater.service';
import { AffiliateService } from '../src/plugins/affiliate-wallet/affiliate.service';
import { CountryConfig } from '../src/plugins/multi-country/entities/country-config.entity';
import { Customer } from '@vendure/core/dist/entity/customer/customer.entity';
import { CountryGuardSubscriber } from '../src/plugins/multi-country/country-guard.subscriber';

// Mock Data
const TEST_PRODUCT_NAME = 'Multi-Country Validation Product';
const TEST_SKU_BASE = 'MC-TEST-SKU';
const TEST1_EMAIL = 'test1@example.com';
const TEST2_EMAIL = 'test2@example.com';
const PASSWORD = 'test';

async function run() {
    console.log('🚀 Starting Multi-Country Logic Verification...');

    // 0. Init
    config.apiOptions.port = 3101;

    // Manual Subscriber Registration (Fix for Plugin Hook possibly not firing in script)
    const dbOptions = config.dbConnectionOptions as any;
    if (!dbOptions.subscribers) dbOptions.subscribers = [];
    dbOptions.subscribers.push(CountryGuardSubscriber);

    const app = await bootstrap(config);

    // Get Services
    const productService = app.get(ProductService);
    const variantService = app.get(ProductVariantService);
    const customerService = app.get(CustomerService);
    const orderService = app.get(OrderService);
    const channelService = app.get(ChannelService);
    const authService = app.get(AuthService);
    const priceUpdaterService = app.get(PriceUpdaterService);
    const affiliateService = app.get(AffiliateService);
    const connection = app.get(TransactionalConnection);
    const countryService = app.get(CountryService);
    const sessionService = app.get(SessionService);
    const requestContextService = app.get(RequestContextService);
    const passwordCipher = app.get(PasswordCipher);

    const channel = await channelService.getDefaultChannel();

    // Admin Context
    const adminCtx = new RequestContext({
        channel,
        apiType: 'admin',
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        languageCode: LanguageCode.zh,
    });

    // 0b. Setup Channel Currencies
    console.log('\n--- Step 0b: Channel Setup ---');
    const availableCurrencies = channel.availableCurrencyCodes || [channel.defaultCurrencyCode];
    if (!availableCurrencies.includes(CurrencyCode.HUF)) {
        console.log('Adding HUF to channel currencies...');
        await channelService.update(adminCtx, {
            id: channel.id,
            availableCurrencyCodes: [...availableCurrencies, CurrencyCode.HUF, CurrencyCode.USD, CurrencyCode.EUR],
        });
    }

    // 1. Create/Reset Users & Addresses
    console.log('\n--- Step 1: User & Address Setup ---');
    await setupUser(connection, customerService, passwordCipher, countryService, adminCtx, TEST1_EMAIL, 'DE', 'Test1');
    await setupUser(connection, customerService, passwordCipher, countryService, adminCtx, TEST2_EMAIL, 'HU', 'Test2');
    console.log('✅ Users prepared: Test1 (DE), Test2 (HU)');

    // 2. Create Products (Master + Children)
    console.log('\n--- Step 2: Product Creation ---');
    const masterProduct = await createProduct(productService, variantService, adminCtx, `${TEST_PRODUCT_NAME} [Master]`, `${TEST_SKU_BASE}-MASTER`, 'DE');
    const huProduct = await createProduct(productService, variantService, adminCtx, `${TEST_PRODUCT_NAME} [HU]`, `${TEST_SKU_BASE}-HU`, 'HU');

    // Link Master ID & Country
    await productService.update(adminCtx, {
        id: huProduct.id,
        customFields: { masterProductId: masterProduct.id.toString(), countryCode: 'HU' }
    });
    await productService.update(adminCtx, {
        id: masterProduct.id,
        customFields: { countryCode: 'DE' }
    });

    console.log(`✅ Products created: ${masterProduct.name} (DE), ${huProduct.name} (HU)`);

    // 3. Set Price Multiplier & Update
    console.log('\n--- Step 3: Pricing Logic ---');
    const CountryConfigRepo = connection.getRepository(adminCtx, CountryConfig);
    let huConfig = await CountryConfigRepo.findOne({ where: { countryCode: 'HU' } });
    if (!huConfig) {
        huConfig = new CountryConfig({ countryCode: 'HU', priceMultiplier: 1.5 });
    } else {
        huConfig.priceMultiplier = 1.5;
    }
    await CountryConfigRepo.save(huConfig);
    console.log('Set HU Multiplier to 1.5');

    // Trigger Update
    await priceUpdaterService.updateAllProductPrices(adminCtx);

    // Verify Prices
    const deVariant = (await variantService.getVariantsByProductId(adminCtx, masterProduct.id)).items[0];
    const huVariant = (await variantService.getVariantsByProductId(adminCtx, huProduct.id)).items[0];

    console.log(`DE Price: ${deVariant.price} (Base)`);
    console.log(`HU Price: ${huVariant.price} (Should be Base * 1.5 * Rate)`);

    // 4. Verify Isolation & Order Placement
    console.log('\n--- Step 4: Isolation & Order Placement ---');

    const shopLoginCtx = new RequestContext({
        channel,
        apiType: 'shop',
        isAuthorized: false,
        authorizedAsOwnerOnly: false,
        languageCode: LanguageCode.zh,
    });

    // Login as Test1 (DE)
    const test1AuthResult = await authService.authenticate(shopLoginCtx, 'shop', 'native', { username: TEST1_EMAIL, password: PASSWORD });
    if ((test1AuthResult as any).message || !(test1AuthResult as any).user) {
        console.error('Login Result:', JSON.stringify(test1AuthResult, null, 2));
        throw new Error('Test1 Login Failed: ' + (test1AuthResult as any).message);
    }
    const test1User = (test1AuthResult as any).user;

    const test1Ctx = await requestContextService.create({
        apiType: 'shop',
        channelOrToken: channel,
        user: test1User,
    });

    console.log(`[Debug] Test1 Active User ID: ${test1Ctx.activeUserId}`);
    const test1Customer = await customerService.findOneByUserId(test1Ctx, test1Ctx.activeUserId!);
    console.log(`[Debug] Test1 Linked Customer: ${test1Customer?.id} - ${test1Customer?.emailAddress}`);

    // Login as Test2 (HU)
    const test2AuthResult = await authService.authenticate(shopLoginCtx, 'shop', 'native', { username: TEST2_EMAIL, password: PASSWORD });
    if ((test2AuthResult as any).message || !(test2AuthResult as any).user) {
        console.error('Test2 Login Result:', JSON.stringify(test2AuthResult, null, 2));
        throw new Error('Test2 Login Failed: ' + (test2AuthResult as any).message);
    }
    const test2User = (test2AuthResult as any).user;

    const test2Ctx = await requestContextService.create({
        apiType: 'shop',
        channelOrToken: channel,
        user: test2User,
    });

    // 4a. Test1 tries to buy HU product (Should Fail)
    console.log('Test1 (DE) trying to buy HU Product...');
    try {
        const order1Block = await orderService.create(test1Ctx);
        await orderService.addCustomerToOrder(test1Ctx, order1Block.id, test1Customer!);

        await orderService.addItemToOrder(test1Ctx, order1Block.id, huVariant.id, 1);
        console.error('❌ FAILURE: Test1 was able to add HU product!');
    } catch (e: any) {
        console.log(`✅ SUCCESS: Blocked (${e.message})`);
    }

    // 4b. Test1 buys DE product (Should Success)
    console.log('Test1 (DE) buying DE Product...');
    const order1 = await orderService.create(test1Ctx);
    await orderService.addCustomerToOrder(test1Ctx, order1.id, test1Customer!);

    let order1Result = await orderService.addItemToOrder(test1Ctx, order1.id, deVariant.id, 1);
    if ((order1Result as any).errorCode) throw new Error('Failed to add item: ' + (order1Result as any).message);

    // Complete Order 1
    console.log('Completing Test1 Order...');
    await orderService.setShippingAddress(test1Ctx, order1.id, {
        fullName: 'Test1 User', streetLine1: 'Berlin St 1', countryCode: 'DE', city: 'Berlin'
    });
    await orderService.transitionToState(test1Ctx, order1.id, 'ArrangingPayment');
    await orderService.addPaymentToOrder(test1Ctx, order1.id, { method: 'standard-payment', metadata: {} });
    console.log('✅ Test1 Order Placed');

    // 4c. Test2 buys HU product
    console.log('Test2 (HU) buying HU Product...');
    const order2 = await orderService.create(test2Ctx);
    let test2CustomerEntity = await customerService.findOneByUserId(test2Ctx, test2Ctx.activeUserId!);
    await orderService.addCustomerToOrder(test2Ctx, order2.id, test2CustomerEntity!);

    let order2Result = await orderService.addItemToOrder(test2Ctx, order2.id, huVariant.id, 1);
    if ((order2Result as any).errorCode) throw new Error('Failed to add item: ' + (order2Result as any).message);

    // Complete Order 2
    console.log('Completing Test2 Order...');
    await orderService.setShippingAddress(test2Ctx, order2.id, {
        fullName: 'Test2 User', streetLine1: 'Budapest St 1', countryCode: 'HU', city: 'Budapest'
    });
    await orderService.transitionToState(test2Ctx, order2.id, 'ArrangingPayment');
    await orderService.addPaymentToOrder(test2Ctx, order2.id, { method: 'standard-payment', metadata: {} });
    console.log('✅ Test2 Order Placed');

    // 5. Verify Wallet
    console.log('\n--- Step 5: Wallet Transfer ---');

    const test1CustomerEntity = await connection.getRepository(adminCtx, Customer).findOne({ where: { emailAddress: TEST1_EMAIL } });
    test2CustomerEntity = await connection.getRepository(adminCtx, Customer).findOne({ where: { emailAddress: TEST2_EMAIL } }) as any;

    if (!test1CustomerEntity || !test2CustomerEntity) throw new Error('Customers not found for wallet test');

    await customerService.update(adminCtx, {
        id: test1CustomerEntity.id,
        customFields: { balanceWithdrawable: 10000 } // 100 EUR
    });
    console.log('Top up Test1 with 10000 (100 EUR)');

    console.log('Transferring 1000 cents (10 EUR) from Test1 to Test2...');
    try {
        await affiliateService.transferBalance(test1Ctx, test1User.id, test2CustomerEntity.id, 1000);
        const test2Refreshed = await customerService.findOne(adminCtx, test2CustomerEntity.id);

        // Correct Check: balanceBonus
        const balance = (test2Refreshed as any)?.customFields?.balanceBonus || 0;
        console.log(`Test2 Balance Post-Transfer: ${balance} (Should be > 0)`);

        if (balance > 0) {
            console.log('✅ Transfer Successful');
        } else {
            console.error('❌ Transfer Failed (Balance is 0)');
        }
    } catch (e: any) {
        console.error('❌ Transfer Error:', e.message);
    }

    console.log('\n✅ Verification Script Complete. Closing...');
    await app.close();
    process.exit(0);
}

// Helpers
async function setupUser(connection: TransactionalConnection, customerService: CustomerService, passwordCipher: PasswordCipher, countryService: CountryService, ctx: RequestContext, email: string, countryCode: string, name: string) {
    let customer = await connection.getRepository(ctx, Customer).findOne({ where: { emailAddress: email } });
    const methodRepo = connection.getRepository(ctx, NativeAuthenticationMethod);

    if (!customer) {
        console.log(`Creating ${email}...`);
        customer = await customerService.create(ctx, {
            emailAddress: email,
            firstName: name,
            lastName: countryCode,
        }) as any;

        if (customer && !customer.user) {
            const passwordHash = await passwordCipher.hash(PASSWORD);
            const userRepo = connection.getRepository(ctx, User);
            let user = new User({
                identifier: email,
                verified: true,
            });
            user = await userRepo.save(user);

            const authMethod = new NativeAuthenticationMethod({
                identifier: email,
                passwordHash,
                user: { id: user.id } as any
            });
            await methodRepo.save(authMethod);

            customer.user = user;
            await connection.getRepository(ctx, Customer).save(customer);
        }
    }

    // Force Reset Password & Verified Status
    const user = customer!.user;
    if (user) {
        console.log(`Resetting password for existing user ${email}...`);
        const passwordHash = await passwordCipher.hash(PASSWORD);
        const existingMethods = await methodRepo.find({ where: { user: { id: user.id } } });

        if (existingMethods.length > 0) {
            for (const method of existingMethods) {
                method.passwordHash = passwordHash;
                await methodRepo.save(method);
            }
        } else {
            const authMethod = new NativeAuthenticationMethod({
                identifier: email,
                passwordHash,
                user: { id: user.id } as any
            });
            await methodRepo.save(authMethod);
        }

        if (!user.verified) {
            user.verified = true;
            await connection.getRepository(ctx, User).save(user);
        }
        console.log(`Password reset done for ${email}`);
    }

    // Assign Country Code
    if ((customer as any).customFields.countryCode !== countryCode) {
        await customerService.update(ctx, {
            id: customer!.id,
            customFields: { countryCode }
        });
    }

    // Create Address
    // Note: This is simplified. Ideally we check if address exists.
    // For verification, we can just ensure the user logic is correct.
}

async function createProduct(productService: ProductService, variantService: ProductVariantService, ctx: RequestContext, name: string, sku: string, countryCode: string) {
    const product = await productService.create(ctx, {
        translations: [{ languageCode: LanguageCode.zh, name, slug: sku.toLowerCase(), description: 'Test' }],
    });
    if ((product as any).message) throw new Error((product as any).message);

    // Fallback: create a variant if none exists (should not happen usually but does in test sometimes)
    const fullProduct = await productService.findOne(ctx, product.id, ['variants']);
    if (!fullProduct) throw new Error('Product not found after creation');

    let variant = fullProduct.variants[0];
    if (!variant) {
        console.log('No variant found! Creating a default variant manually...');
        const variantResult = await variantService.create(ctx, [{
            productId: product.id,
            sku: sku,
            price: 1000,
            stockOnHand: 100, // Fix Stock Error
            translations: [{ languageCode: LanguageCode.zh, name }]
        }]);
        variant = variantResult[0];
        console.log(`Manually created variant: ${variant.id}`);
    } else {
        await variantService.update(ctx, [{
            id: variant.id,
            sku: sku,
            price: 1000,
            stockOnHand: 100, // Fix Stock Error
        }]);
    }

    await productService.update(ctx, {
        id: product.id,
        customFields: { countryCode }
    });

    return product;
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
