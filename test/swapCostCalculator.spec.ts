// Tests costOutputToken
import { expect } from 'chai';
import { BigNumber } from '@ethersproject/bignumber';
import { calculateTotalSwapCost, SwapCostCalculator } from '../src/swapCost';
import { DAI, MKR, USDC, WETH } from './lib/constants';
import { MockTokenPriceService } from './lib/mockTokenPriceService';

describe('calculateTotalSwapCost', () => {
    it('should return correct total swap cost', async () => {
        const gasPriceWei = BigNumber.from('30000000000'); // 30GWEI
        const swapGas = BigNumber.from('100000');
        const tokenPriceWei = BigNumber.from('352480995000000000');

        const totalSwapCost = calculateTotalSwapCost(
            tokenPriceWei,
            swapGas,
            gasPriceWei
        );

        const expectedTotalSwapCost = BigNumber.from('1057442985000000');
        expect(expectedTotalSwapCost).to.eql(totalSwapCost);
    });

    it('should return correct total swap cost', async () => {
        const gasPriceWei = BigNumber.from('30000000000'); // 30GWEI
        const swapGas = BigNumber.from('100000');
        const tokenPriceWei = BigNumber.from('240000000000000000000');

        const totalSwapCost = calculateTotalSwapCost(
            tokenPriceWei,
            swapGas,
            gasPriceWei
        );

        const expectedTotalSwapCost = BigNumber.from('720000000000000000');
        expect(expectedTotalSwapCost).to.eql(totalSwapCost);
    });
});

describe('Test SwapCostCalculator', () => {
    describe('convertGasCostToToken', () => {
        it('Should return 0 if the token price service throws an error', async () => {
            const gasPriceWei = BigNumber.from('30000000000');
            const swapGas = BigNumber.from('100000');
            const costExpected = BigNumber.from('0');

            const cost = await new SwapCostCalculator(1, {
                getNativeAssetPriceInToken(): Promise<string> {
                    throw new Error('unrecognized token');
                },
            }).convertGasCostToToken('0x0', 18, gasPriceWei, swapGas);

            expect(cost).to.eql(costExpected);
        });

        it('Should cost 12 DAI with a $4,000 ETH and 30GWEI Gas Price', async () => {
            const gasPriceWei = BigNumber.from('30000000000');
            const swapGas = BigNumber.from('100000');
            const daiPrice = BigNumber.from('1');
            const ethPrice = BigNumber.from('4000');
            const swapCostInDAI = BigNumber.from('12000000000000000000');

            const cost = await new SwapCostCalculator(
                1,
                new MockTokenPriceService(ethPrice.div(daiPrice).toString())
            ).convertGasCostToToken(
                DAI.address,
                DAI.decimals,
                gasPriceWei,
                swapGas
            );

            expect(cost.toString()).to.eql(swapCostInDAI.toString());
        });

        it('Should cost 12 USDC with a $4,000 ETH and 30GWEI Gas Price', async () => {
            const gasPriceWei = BigNumber.from('30000000000');
            const swapGas = BigNumber.from('100000');
            const usdcPrice = BigNumber.from('1');
            const ethPrice = BigNumber.from('4000');
            const swapCostInUSDC = BigNumber.from('12000000');

            const cost = await new SwapCostCalculator(
                1,
                new MockTokenPriceService(ethPrice.div(usdcPrice).toString())
            ).convertGasCostToToken(
                USDC.address,
                USDC.decimals,
                gasPriceWei,
                swapGas
            );

            expect(cost.toString()).to.eql(swapCostInUSDC.toString());
        });

        it('Should cost 0.003 MKR with a $4,000 ETH, $2,500 MKR and 30GWEI Gas Price', async () => {
            const gasPriceWei = BigNumber.from('30000000000');
            const swapGas = BigNumber.from('100000');
            const mkrPrice = BigNumber.from('2500');
            const ethPrice = BigNumber.from('4000');
            const swapCostInMKR = BigNumber.from('3000000000000000'); //0.003

            const cost = await new SwapCostCalculator(
                1,
                new MockTokenPriceService(ethPrice.div(mkrPrice).toString())
            ).convertGasCostToToken(
                MKR.address,
                MKR.decimals,
                gasPriceWei,
                swapGas
            );

            expect(cost.toString()).to.eql(swapCostInMKR.toString());
        });

        it('Should cost gasPriceWei * swapGas when paying in WETH', async () => {
            const gasPriceWei = BigNumber.from('30000000000');
            const swapGas = BigNumber.from('100000');

            const cost = await new SwapCostCalculator(
                1,
                new MockTokenPriceService('1')
            ).convertGasCostToToken(
                WETH.address,
                WETH.decimals,
                gasPriceWei,
                swapGas
            );

            expect(cost.toString()).to.eql(gasPriceWei.mul(swapGas).toString());
        });
    });
});
