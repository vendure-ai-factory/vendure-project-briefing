// LTS_LOCKDOWN_TEST
    dummyPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    VendureConfig,
    LanguageCode,
    CurrencyCode,
    defaultShippingCalculator,
    defaultShippingEligibilityChecker,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import { StoreCreditPlugin } from '@avendure/vendure-plugin-store-credit';
import { StripeSubscriptionPlugin } from '@pinelab/vendure-plugin-stripe-subscription';
import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
import { VariantBulkUpdatePlugin } from '@pinelab/vendure-plugin-variant-bulk-update';
import { AffiliateWalletPlugin } from './plugins/affiliate-wallet';
import { StripeConnectPlugin } from './plugins/stripe-connect';
import { VendorDashboardPlugin } from './plugins/vendor-dashboard';
import { NailCustomizationPlugin } from './plugins/nail-customization';
import { UniversalOnboardingPlugin } from './plugins/universal-onboarding/universal-onboarding.plugin';
import { NailPriceCalculationStrategy } from './plugins/nail-customization/price-calculation.strategy';
import 'dotenv/config';
import { germanPostCalculator } from './plugins/shipping-extensions/german-post-calculator';
import path from 'path';

// MultiCountry logic removed for migration to native channels

const IS_DEV = process.env.APP_ENV === 'dev';
const serverPort = +process.env.PORT || 3000;

export const config: VendureConfig = {
    defaultLanguageCode: LanguageCode.zh,
    apiOptions: {
        port: serverPort,
        hostname: '0.0.0.0',
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        cors: {
            origin: true,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'vendure-auth-token'],
        },
        trustProxy: IS_DEV ? false : 1,
        // The following options are useful in development mode,
        // but are best turned off for production for security
        // reasons.
        ...(IS_DEV ? {
            adminApiDebug: true,
            shopApiDebug: true,
        } : {}),
    },
    authOptions: {
        tokenMethod: 'bearer',
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'better-sqlite3',
        // See the README.md "Migrations" section for an explanation of
        // the `synchronize` and `migrations` options.
        synchronize: true,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: path.join(__dirname, '../vendure.sqlite'),
        subscribers: [],
        extra: {
            timeout: 60000,
        },
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    orderOptions: {
        orderItemPriceCalculationStrategy: new NailPriceCalculationStrategy(),
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    // Note: stripeAccountId is defined by StripeConnectPlugin, do not redefine here.
    customFields: {
        Customer: [
            {
                name: 'balanceWithdrawable',
                type: 'int',
                public: true,
                defaultValue: 0,
                label: [{ languageCode: LanguageCode.zh, value: '可提现余额' }, { languageCode: LanguageCode.en, value: 'Withdrawable Balance' }],
                description: [{ languageCode: LanguageCode.zh, value: '来自设计收益可提现的金额(分)' }, { languageCode: LanguageCode.en, value: 'Amount from earnings that can be withdrawn (cents)' }],
            },
            {
                name: 'balanceBonus',
                type: 'int',
                public: true,
                defaultValue: 0,
                label: [{ languageCode: LanguageCode.zh, value: '站内赠金' }, { languageCode: LanguageCode.en, value: 'Station Bonus' }],
                description: [{ languageCode: LanguageCode.zh, value: '仅限站内消费的余额(分)' }, { languageCode: LanguageCode.en, value: 'Balance for station consumption only (cents)' }],
            },
        ],
        Product: [
            {
                name: 'masterProductId',
                type: 'string',
                public: true,
                defaultValue: '',
                label: [{ languageCode: LanguageCode.zh, value: '主商品ID' }, { languageCode: LanguageCode.en, value: 'Master Product ID' }],
                description: [{ languageCode: LanguageCode.zh, value: '关联的虚拟主商品ID，用于统计销量' }, { languageCode: LanguageCode.en, value: 'Linked Master Product ID for sales stats' }],
            },
        ],
        ProductVariant: [
            {
                name: 'weight',
                type: 'int',
                public: true,
                defaultValue: 0,
                label: [{ languageCode: LanguageCode.zh, value: '重量' }, { languageCode: LanguageCode.en, value: 'Weight' }],
                description: [{ languageCode: LanguageCode.zh, value: '单位：克' }, { languageCode: LanguageCode.en, value: 'Unit: grams' }],
            },
            {
                name: 'pearlSurcharge',
                type: 'int',
                public: true,
                defaultValue: 0,
                label: [{ languageCode: LanguageCode.zh, value: '珠光加价(分)' }, { languageCode: LanguageCode.en, value: 'Pearl Surcharge (cents)' }],
            },
            {
                name: 'silverSurcharge',
                type: 'int',
                public: true,
                defaultValue: 0,
                label: [{ languageCode: LanguageCode.zh, value: '银闪加价(分)' }, { languageCode: LanguageCode.en, value: 'Silver Surcharge (cents)' }],
            },
        ],
    },
    shippingOptions: {
        shippingCalculators: [germanPostCalculator, defaultShippingCalculator],
        shippingEligibilityCheckers: [defaultShippingEligibilityChecker],
    },
    plugins: [
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, '../static/assets'),
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: IS_DEV ? undefined : 'https://www.my-shop.com/assets/',
        }),
        DefaultSchedulerPlugin.init(),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            devMode: true,
            outputPath: path.join(__dirname, '../static/email/test-emails'),
            route: 'mailbox',
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implementation.
                // Here we are assuming a storefront running at http://localhost:8080.
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:8080/verify',
                passwordResetUrl: 'http://localhost:8080/password-reset',
                changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change'
            },
        }),
        DashboardPlugin.init({
            route: 'dashboard',
            appDir: IS_DEV
                ? path.join(__dirname, '../dist/dashboard')
                : path.join(__dirname, 'dashboard'),
        }),
        StoreCreditPlugin.init({}),
        StripeSubscriptionPlugin,
        StripePlugin.init({
            storeCustomersInStripe: true,
            // Enable auto-capture (Settlement) upon authorization can be configured via PaymentMethod handler if needed
        }),
        AffiliateWalletPlugin,
        StripeConnectPlugin,
        VendorDashboardPlugin,
        NailCustomizationPlugin,
        VariantBulkUpdatePlugin.init({
            enablePriceBulkUpdate: true,
            bulkUpdateCustomFields: ['pearlSurcharge', 'silverSurcharge'],
        }),
        UniversalOnboardingPlugin,
    ],
};
LTS_INTERNAL_TEST
FAIL_TEST
// [LTS] PHYSICAL_LOCKDOWN_VERIFIED_SUCCESSFULLY
