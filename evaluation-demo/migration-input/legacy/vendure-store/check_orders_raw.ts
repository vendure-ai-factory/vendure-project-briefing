
import { createConnection } from 'typeorm';
import path from 'path';

async function checkOrders() {
    const connection = await createConnection({
        type: 'sqlite',
        database: path.join(__dirname, 'vendure.sqlite'),
        entities: [], // We use raw query
        logging: false,
    });

    const results = await connection.query("SELECT id, code, state, createdAt FROM 'order' ORDER BY createdAt DESC LIMIT 5;");
    console.log('Latest 5 orders:');
    console.log(JSON.stringify(results, null, 2));

    await connection.close();
}

checkOrders().catch(console.error);
