import { formatPrice } from './src/lib/format';

function testFormat() {
    console.log('--- formatPrice Unit Tests ---');
    
    const cases = [
        { price: 150, currency: 'HUF', expected: '150\u00a0Ft' }, // Non-breaking space
        { price: 1999, currency: 'HUF', expected: '1\u00a0999\u00a0Ft' },
        { price: 150, currency: 'EUR', expected: '1,50\u00a0€' },
        { price: 1000, currency: 'EUR', expected: '10,00\u00a0€' },
    ];
    
    let allPassed = true;
    for (const c of cases) {
        const result = formatPrice(c.price, c.currency);
        // Normalize spaces for comparison
        const normalizedResult = result.replace(/\u00a0/g, ' ').replace(/\s/g, ' ');
        const normalizedExpected = c.expected.replace(/\u00a0/g, ' ').replace(/\s/g, ' ');
        
        if (normalizedResult === normalizedExpected) {
            console.log(`✅ [${c.currency}] ${c.price} -> ${result} (Match)`);
        } else {
            console.log(`❌ [${c.currency}] ${c.price} -> ${result} (Expected: ${c.expected})`);
            allPassed = false;
        }
    }
    
    if (allPassed) {
        console.log('--- ALL TESTS PASSED ---');
    } else {
        console.log('--- SOME TESTS FAILED ---');
        process.exit(1);
    }
}

testFormat();
