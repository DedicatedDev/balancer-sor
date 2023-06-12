import { getAddress } from '@ethersproject/address';
import { BigNumber, formatFixed, parseFixed } from '@ethersproject/bignumber';
import { Zero } from '@ethersproject/constants';
import { BigNumber as OldBigNumber, ZERO, bnum } from './big-number';
import { isSameAddress } from '../../utils';
import { universalNormalizedLiquidity } from '../liquidity';
import {
    PoolBase,
    PoolPairBase,
    PoolTypes,
    SubgraphPoolBase,
    SubgraphToken,
    SwapTypes,
} from '../../types';
import {
    poolBalancesToNumeraire,
    viewRawAmount,
    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut,
    _exactTokenInForTokenOut,
    _spotPriceAfterSwapExactTokenInForTokenOut,
    _spotPriceAfterSwapTokenInForExactTokenOut,
    _tokenInForExactTokenOut,
} from './fxPoolMath';

type FxPoolToken = Pick<
    SubgraphToken,
    'address' | 'balance' | 'decimals' | 'token'
>;

/**
 * Replicates the conversion operation to 64.64 fixed point numbers (ABDK library)
 * that occurs in the smart contract. This is done to replicate the loss of precision
 * from the smart contract.
 *
 * For example: in 1e18 decimals, when converting _epsilon_ `0.0015` from `uint256`
 * to a 64.64 fixed point number (`(_epsilon + 1).divu(1e18)`) there is a loss
 * of precision. In 64.64 fixed point, epsilon is stored as 0.001500000000000000953.
 * This is the value that is used in calculations in the smart contract.
 *
 * When converted from 64.64 fixed point back to `uint256` the value is
 * 0.001500000000000000 which is the same as the original value of 0.0015.
 * This is what the graph is seeing.
 *
 * This function is used to replicate the same loss of precision that occurs
 * in the smart contract so that we work with an epsilon value of
 * 0.001500000000000000953 instead of 0.0015.
 *
 * @param param any of the pool's curve parameters like alpha, beta, lambda, delta, epsilon
 * @returns OldBigNumber with the same loss of precision as the smart contract
 */
const parseFixedCurveParam = (param: string): OldBigNumber => {
    const param64 =
        ((((BigInt(parseFixed(param, 18).toString()) + 1n) << 64n) /
            10n ** 18n) *
            10n ** 36n) >>
        64n;
    return bnum(param64.toString())
        .div(bnum(10).pow(18))
        .decimalPlaces(3, OldBigNumber.ROUND_UP);
};

export type FxPoolPairData = PoolPairBase & {
    alpha: OldBigNumber;
    beta: OldBigNumber;
    lambda: OldBigNumber;
    delta: OldBigNumber;
    epsilon: OldBigNumber;
    tokenInLatestFXPrice: OldBigNumber;
    tokenInfxOracleDecimals: OldBigNumber;
    tokenOutLatestFXPrice: OldBigNumber;
    tokenOutfxOracleDecimals: OldBigNumber;
};

export class FxPool implements PoolBase<FxPoolPairData> {
    poolType: PoolTypes = PoolTypes.Fx;
    id: string;
    address: string;
    swapFee: BigNumber;
    totalShares: BigNumber;
    tokens: FxPoolToken[];
    tokensList: string[];
    alpha: OldBigNumber;
    beta: OldBigNumber;
    lambda: OldBigNumber;
    delta: OldBigNumber;
    epsilon: OldBigNumber;

    static fromPool(pool: SubgraphPoolBase): FxPool {
        if (
            !pool.alpha ||
            !pool.beta ||
            !pool.lambda ||
            !pool.delta ||
            !pool.epsilon
        )
            throw new Error('FX Pool Missing Subgraph Field');
        return new FxPool(
            pool.id,
            pool.address,
            pool.swapFee,
            pool.totalShares,
            pool.tokens,
            pool.tokensList,
            pool.alpha,
            pool.beta,
            pool.lambda,
            pool.delta,
            pool.epsilon
        );
    }

    constructor(
        id: string,
        address: string,
        swapFee: string,
        totalShares: string,
        tokens: FxPoolToken[],
        tokensList: string[],
        alpha: string,
        beta: string,
        lambda: string,
        delta: string,
        epsilon: string
    ) {
        this.id = id;
        this.address = address;
        this.swapFee = parseFixed(swapFee, 18);
        this.totalShares = parseFixed(totalShares, 18);
        this.tokens = tokens;
        this.tokensList = tokensList;
        this.alpha = parseFixedCurveParam(alpha);
        this.beta = parseFixedCurveParam(beta);
        this.lambda = parseFixedCurveParam(lambda);
        this.delta = parseFixedCurveParam(delta);
        this.epsilon = parseFixedCurveParam(epsilon);
    }
    updateTotalShares: (newTotalShares: BigNumber) => void;
    mainIndex?: number | undefined;
    isLBP?: boolean | undefined;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcTokensOutGivenExactBptIn(bptAmountIn: BigNumber): BigNumber[] {
        // Will copy over other implementations, not supporting BPT tokens atm
        return new Array(this.tokens.length).fill(Zero);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcBptOutGivenExactTokensIn(amountsIn: BigNumber[]): BigNumber {
        // Will copy over other implementations, not supporting BPT tokens atm
        return Zero;
    }

    parsePoolPairData(tokenIn: string, tokenOut: string): FxPoolPairData {
        const tokenIndexIn = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenIn)
        );
        if (tokenIndexIn < 0) throw 'Pool does not contain tokenIn';
        const tI = this.tokens[tokenIndexIn];
        const balanceIn = tI.balance;
        const decimalsIn = tI.decimals;

        const tokenIndexOut = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenOut)
        );

        if (tokenIndexOut < 0) throw 'Pool does not contain tokenOut';
        const tO = this.tokens[tokenIndexOut];
        const balanceOut = tO.balance;
        const decimalsOut = tO.decimals;

        if (!tO.token?.latestFXPrice || !tI.token?.latestFXPrice)
            throw 'FX Pool Missing LatestFxPrice';
        if (!tO.token?.fxOracleDecimals || !tI.token?.fxOracleDecimals)
            throw 'FX Pool Missing tokenIn or tokenOut fxOracleDecimals';

        const poolPairData: FxPoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            balanceIn: parseFixed(balanceIn, decimalsIn),
            balanceOut: parseFixed(balanceOut, decimalsOut),
            swapFee: this.swapFee,
            alpha: this.alpha,
            beta: this.beta,
            lambda: this.lambda,
            delta: this.delta,
            epsilon: this.epsilon,
            tokenInLatestFXPrice: bnum(
                parseFixed(
                    tI.token.latestFXPrice,
                    tI.token.fxOracleDecimals
                ).toString()
            ), // decimals is formatted from subgraph in rate we get from the chainlink oracle
            tokenOutLatestFXPrice: bnum(
                parseFixed(
                    tO.token.latestFXPrice,
                    tO.token.fxOracleDecimals
                ).toString()
            ), // decimals is formatted from subgraph in rate we get from the chainlink oracle
            tokenInfxOracleDecimals: bnum(tI.token.fxOracleDecimals),
            tokenOutfxOracleDecimals: bnum(tO.token.fxOracleDecimals),
        };

        return poolPairData;
    }

    // Normalized liquidity is an abstract term that can be thought of the
    // inverse of the slippage. It is proportional to the token balances in the
    // pool but also depends on the shape of the invariant curve.
    // As a standard, we define normalized liquidity in tokenOut
    getNormalizedLiquidity(poolPairData: FxPoolPairData): OldBigNumber {
        return universalNormalizedLiquidity(
            this._derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                poolPairData,
                ZERO
            )
        );
    }

    /*
    Fx pool logic has an alpha region where it halts swaps.
    maxLimit  = [(1 + alpha) * oGLiq * 0.5] - token value in numeraire
    */
    getLimitAmountSwap(
        poolPairData: FxPoolPairData,
        swapType: SwapTypes
    ): OldBigNumber {
        try {
            const parsedReserves = poolBalancesToNumeraire(poolPairData);

            const alphaValue = poolPairData.alpha.div(bnum(10).pow(18));

            const maxLimit = alphaValue
                .plus(1)
                .times(parsedReserves._oGLiq)
                .times(0.5);

            if (swapType === SwapTypes.SwapExactIn) {
                const maxLimitAmount = maxLimit.minus(
                    parsedReserves.tokenInReservesInNumeraire
                );

                return viewRawAmount(
                    maxLimitAmount,
                    bnum(poolPairData.decimalsIn),
                    poolPairData.tokenInLatestFXPrice,
                    poolPairData.tokenInfxOracleDecimals
                ).div(bnum(10).pow(poolPairData.decimalsIn));
            } else {
                const maxLimitAmount = maxLimit.minus(
                    parsedReserves.tokenOutReservesInNumeraire
                );

                return viewRawAmount(
                    maxLimitAmount,
                    bnum(poolPairData.decimalsOut),
                    poolPairData.tokenOutLatestFXPrice,
                    poolPairData.tokenOutfxOracleDecimals
                ).div(bnum(10).pow(poolPairData.decimalsOut));
            }
        } catch {
            return ZERO;
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is BPT
        if (this.address == token) {
            this.totalShares = newBalance;
        } else {
            // token is underlying in the pool
            const T = this.tokens.find((t) => isSameAddress(t.address, token));
            if (!T) throw Error('Pool does not contain this token');
            T.balance = formatFixed(newBalance, T.decimals);
        }
    }

    _exactTokenInForTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _exactTokenInForTokenOut(amount, poolPairData);
        } catch {
            return ZERO;
        }
    }

    _tokenInForExactTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _tokenInForExactTokenOut(amount, poolPairData);
        } catch {
            return ZERO;
        }
    }

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _spotPriceAfterSwapExactTokenInForTokenOut(
                poolPairData,
                amount
            );
        } catch {
            return ZERO;
        }
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _spotPriceAfterSwapTokenInForExactTokenOut(
                poolPairData,
                amount
            );
        } catch {
            return ZERO;
        }
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                amount,
                poolPairData
            );
        } catch {
            return ZERO;
        }
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: FxPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            return _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
                amount,
                poolPairData
            );
        } catch {
            return ZERO;
        }
    }
}
