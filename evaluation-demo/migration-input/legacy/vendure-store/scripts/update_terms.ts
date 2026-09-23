import axios from 'axios';
import fs from 'fs';
import path from 'path';

async function updateTerms() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: ts-node scripts/update_terms.ts <countryCode> <filePath>');
        process.exit(1);
    }

    const countryCode = args[0];
    const filePath = args[1];

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    try {
        // Login
        const loginQuery = `
            mutation Login($u: String!, $p: String!) { 
                login(username: $u, password: $p) { 
                    ... on CurrentUser { id }
                    ... on InvalidCredentialsError { message }
                } 
            }
        `;

        const loginRes = await axios.post('http://localhost:3000/admin-api', {
            query: loginQuery,
            variables: { u: process.env.SUPERADMIN_USERNAME || 'REPLACE_WITH_EVALUATION_ADMIN_USERNAME', p: process.env.SUPERADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD' }
        });

        const loginData = loginRes.data;
        if (loginData.errors || loginData.data?.login?.message) {
            console.error('Login failed', loginData.errors || loginData.data.login.message);
            process.exit(1);
        }

        const token = loginRes.headers['vendure-auth-token'];
        if (!token) {
            console.error('No auth token received');
            process.exit(1);
        }

        // Update Terms
        const updateMutation = `
            mutation UpdateTerms($cc: String!, $c: String!) {
                updateCountryTerms(countryCode: $cc, content: $c) {
                    id
                    countryCode
                }
            }
        `;

        const updateRes = await axios.post('http://localhost:3000/admin-api', {
            query: updateMutation,
            variables: { cc: countryCode, c: content }
        }, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const updateData = updateRes.data;
        if (updateData.errors) {
            console.error('Update failed', updateData.errors);
            process.exit(1);
        }

        console.log(`Successfully updated terms for ${countryCode}`);

    } catch (error: any) {
        console.error('Error executing script:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

updateTerms();
