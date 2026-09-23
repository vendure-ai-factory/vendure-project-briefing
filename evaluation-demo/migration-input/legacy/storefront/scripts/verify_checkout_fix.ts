import { query } from '../src/lib/vendure/api';
import { GetEligibleShippingMethodsQuery, GetActiveOrderForCheckoutQuery } from '../src/lib/vendure/queries';
import { login } from '../src/lib/vendure/actions';

async function verify() {
    try {
        console.log('--- STOREFRONT VERIFICATION ---');
        
        // 1. Login as test2@example.com
        console.log('Logging in...');
        const loginRes = await login(process.env.EVALUATION_CUSTOMER_EMAIL || 'test2@example.com', process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');
        console.log(`Login successful. Token preserved in session.`);

        // 2. Check Order in Hungary Channel
        console.log('\nFetching Active Order (Hungary Channel)...');
        const orderRes = await query(GetActiveOrderForCheckoutQuery, {}, { 
            useAuthToken: true, 
            channelToken: 'hungary-channel' 
        });
        
        const activeOrder = orderRes.data.activeOrder;
        if (!activeOrder) {
            console.log('No active order found in hungary-channel.');
            return;
        }
        console.log(`Order Code: ${activeOrder.code}`);
        console.log(`Shipping Address: ${JSON.stringify(activeOrder.shippingAddress?.countryCode)}`);

        // 3. Check Eligible Shipping Methods
        console.log('\nFetching Eligible Shipping Methods...');
        const shippingRes = await query(GetEligibleShippingMethodsQuery, {}, { 
            useAuthToken: true, 
            channelToken: 'hungary-channel' 
        });

        const methods = shippingRes.data.eligibleShippingMethods || [];
        console.log(`Found ${methods.length} methods:`);
        for (const m of methods) {
            console.log(`- [${m.id}] ${m.name} (${m.code}): ${m.priceWithTax}`);
        }

        if (methods.length > 0) {
            console.log('\nSUCCESS: Shipping methods are now available!');
        } else {
            console.log('\nFAILED: Still no shipping methods available.');
        }

    } catch (err) {
        console.error('Verification failed:', err);
    }
}

verify();
