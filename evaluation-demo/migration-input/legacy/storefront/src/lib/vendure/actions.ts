import { query, mutate, AVAILABLE_COUNTRIES_QUERY } from './api';
import { GetActiveCustomerQuery, GetActiveChannelQuery, GET_ACTIVE_KYC_FORM, SUBMIT_KYC_FORM } from './queries';
import { getActiveChannelCached } from './cached';
import { cache } from "react";
import { readFragment } from "@/graphql";
import { ActiveCustomerFragment } from "@/lib/vendure/fragments";
import { getAuthToken } from "@/lib/auth";


export const getActiveCustomer = cache(async () => {
    const token = await getAuthToken();
    const result = await query(GetActiveCustomerQuery, undefined, {
        token,
        fetch: {
            cache: 'no-store'
        }
    });
    return readFragment(ActiveCustomerFragment, result.data.activeCustomer);
})

export const getActiveChannel = async () => {
    const result = await query(GetActiveChannelQuery, undefined, {
        useAuthToken: false // Just get the public active channel for the current context
    });
    return result.data.activeChannel;
};

export const getAvailableCountries = async () => {
    const result = await query(AVAILABLE_COUNTRIES_QUERY, undefined, {
        useAuthToken: false
    });
    return result.data.affiliateAvailableCountries;
};

export const getActiveKycForm = async () => {
    try {
        const result = await query(GET_ACTIVE_KYC_FORM, undefined, {
            useAuthToken: true,
            fetch: { cache: 'no-store' }
        });
        return result.data?.activeAffiliateKycForm;
    } catch (e) {
        console.warn(`[KYC] Could not fetch active form (likely not authenticated): ${e}`);
        return null;
    }
};

export const submitKycForm = async (input: any) => {
    const token = await getAuthToken();
    const result = await mutate(SUBMIT_KYC_FORM, { input }, {
        token
    });
    return result.data?.submitAffiliateKycForm;
};

