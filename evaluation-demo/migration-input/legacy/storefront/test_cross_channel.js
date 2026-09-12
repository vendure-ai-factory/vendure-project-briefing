"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const API_URL = 'http://localhost:54321/shop-api';
const EMAIL = 'test3@example.com';
const PASSWORD = process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD';
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        // 1. Login on Default/Germany channel
        const loginRes = yield fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'vendure-token': 'germany-channel' },
            body: JSON.stringify({
                query: `
                mutation Login($username: String!, $password: String!) {
                    login(username: $username, password: $password) {
                        ... on CurrentUser { id }
                    }
                }
            `,
                variables: { username: EMAIL, password: PASSWORD }
            })
        });
        const token = loginRes.headers.get('vendure-auth-token');
        console.log('Login Auth Token:', token);
        if (!token) {
            console.error("No token received!");
            return;
        }
        // 2. Try to fetch / create profile on AUSTRIA channel
        const fetchRes = yield fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'vendure-token': 'austria-channel', // different channel!
                'vendure-auth-token': token,
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                query: `
                query {
                    myNailProfiles {
                        id
                        profileName
                    }
                }
            `
            })
        });
        const body = yield fetchRes.json();
        console.log('Cross-channel Fetch Result:', JSON.stringify(body, null, 2));
    });
}
run().catch(console.error);
