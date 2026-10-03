import { Injectable } from '@nestjs/common';
import { JobQueue, JobQueueService, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { ExchangeRate } from '../entities/exchange-rate.entity';
import https from 'https';
// Using native https to avoid axios dependency if not present.
// ECB returns XML.

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const BACKUP_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json';

@Injectable()
export class ExchangeRateService {
    constructor(
        private connection: TransactionalConnection,
        private jobQueueService: JobQueueService
    ) { }

    async updateRates() {
        Logger.info('Updating Exchange Rates...', 'MultiCountryPlugin');
        try {
            await this.fetchFromECB();
        } catch (e: any) {
            Logger.error(`ECB Update failed: ${e.message}`, 'MultiCountryPlugin');
            try {
                await this.fetchFromBackup();
            } catch (backupError: any) {
                Logger.error(`Backup Update failed: ${backupError.message}`, 'MultiCountryPlugin');
                // Could implement email notification here
            }
        }
        await this.checkRatesHealth();
    }

    async checkRatesHealth() {
        const latestRate = await this.connection.getRepository(ExchangeRate).findOne({
            order: { date: 'DESC' }
        });

        if (latestRate) {
            const now = new Date();
            const diffTime = Math.abs(now.getTime() - latestRate.date.getTime());
            const diffHours = Math.ceil(diffTime / (1000 * 60 * 60));

            if (diffHours > 48) {
                Logger.error(`CRITICAL: Exchange rates are stale! Last update was ${diffHours} hours ago.`, 'MultiCountryPlugin');
                // TODO: Send email alert
            } else {
                Logger.info(`Exchange rates health check passed. Last update: ${diffHours} hours ago.`, 'MultiCountryPlugin');
            }
        } else {
            Logger.warn('No exchange rates found in database.', 'MultiCountryPlugin');
        }
    }

    async getRate(currencyCode: string): Promise<number> {
        if (currencyCode === 'EUR') return 1;

        // Find latest rate
        const rate = await this.connection.getRepository(ExchangeRate).findOne({
            where: { currencyCode },
            order: { date: 'DESC' }
        });

        if (!rate) {
            Logger.warn(`Exchange rate for ${currencyCode} not found. Defaulting to 1.`, 'MultiCountryPlugin');
            return 1;
        }
        return rate.rate;
    }

    private async fetchFromECB() {
        return new Promise<void>((resolve, reject) => {
            https.get(ECB_URL, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', async () => {
                    try {
                        // Parse XML with regex (simplest, no dep)
                        // Structure: <Cube currency='USD' rate='1.08'/>
                        const regex = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g;
                        let match;
                        const rates: { code: string, rate: number }[] = [];

                        while ((match = regex.exec(data)) !== null) {
                            rates.push({ code: match[1], rate: parseFloat(match[2]) });
                        }

                        if (rates.length > 0) {
                            await this.saveRates(rates, 'ECB');
                            resolve();
                        } else {
                            reject(new Error('No rates found in XML'));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', (err) => reject(err));
        });
    }

    private async fetchFromBackup() {
        return new Promise<void>((resolve, reject) => {
            https.get(BACKUP_URL, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', async () => {
                    try {
                        const json = JSON.parse(data);
                        // Structure: { date: '2024-...', eur: { usd: 1.08, ... } }
                        const ratesObj = json.eur;
                        const rates: { code: string, rate: number }[] = [];

                        for (const [code, rate] of Object.entries(ratesObj)) {
                            rates.push({ code: code.toUpperCase(), rate: Number(rate) });
                        }

                        if (rates.length > 0) {
                            await this.saveRates(rates, 'BackupAPI');
                            resolve();
                        } else {
                            reject(new Error('No rates found in JSON'));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', (err) => reject(err));
        });
    }

    private async saveRates(rates: { code: string, rate: number }[], source: string) {
        const date = new Date();
        const repo = this.connection.getRepository(ExchangeRate);

        // Use a transaction or just loop
        // We only overwrite or add for today?
        // Let's just Insert new records.

        // Ideally we should clear old rates for today or upsert?
        // Let's just save.

        for (const r of rates) {
            // Check if rate typically exists for today?
            // Or just save latest?
            // Let's simplify: Upsert based on currencyCode.
            // We only need the latest rate.

            const existing = await repo.findOne({ where: { currencyCode: r.code } });
            if (existing) {
                existing.rate = r.rate;
                existing.date = date;
                existing.source = source;
                await repo.save(existing);
            } else {
                await repo.save(new ExchangeRate({
                    currencyCode: r.code,
                    rate: r.rate,
                    date: date,
                    source: source
                }));
            }
        }
        Logger.info(`Updated ${rates.length} rates from ${source}`, 'MultiCountryPlugin');
    }
}
