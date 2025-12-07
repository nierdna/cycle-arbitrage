/**
 * Constants for Cycle Arbitrage
 * Contract addresses, ABIs, and event signatures
 */

// BSC Contract Addresses
export const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
export const PANCAKE_V3_POOL_DEPLOYER = '0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9';
export const BITSWAP_V3_ROUTER = '0xb5DFcaC19B4f4f64e9e641D2096d0a80341C655d';

// PancakeSwap V3 Pool Init Code Hash (for CREATE2 address calculation)
export const V3_INIT_CODE_HASH = '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2';

// Factory ABI (minimal)
export const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

// Router ABI (minimal - only swapExactInput)
export const ROUTER_ABI = [
  {
    name: 'swapExactInput',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

// Swap event signature
export const SWAP_EVENT_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';

// Pool Swap event ABI (for parsing receipt)
export const POOL_SWAP_ABI = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'amount0', type: 'int256' },
      { indexed: false, name: 'amount1', type: 'int256' },
      { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
      { indexed: false, name: 'liquidity', type: 'uint128' },
      { indexed: false, name: 'tick', type: 'int24' },
      { indexed: false, name: 'protocolFeesToken0', type: 'uint128' },
      { indexed: false, name: 'protocolFeesToken1', type: 'uint128' },
    ],
  },
];

// Arbitrage Contract ABI (minimal - only execution methods)
export const ARBITRAGE_CONTRACT_ABI = [
  {
    name: 'executeSimpleArbitrage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pool1', type: 'address' },
      { name: 'pool2', type: 'address' },
      { name: 'zeroForOne1', type: 'bool' },
      { name: 'zeroForOne2', type: 'bool' },
      { name: 'exactOutputAmount', type: 'uint256' },  // Exact output amount from Pool1 (số dương)
      { name: 'sqrtPriceLimit1', type: 'uint160' },
      { name: 'sqrtPriceLimit2', type: 'uint160' },
      { name: 'minProfit', type: 'uint256' },
      { name: 'tipAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'executeTriangleArbitrage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pool1', type: 'address' },
      { name: 'pool2', type: 'address' },
      { name: 'pool3', type: 'address' },
      { name: 'zeroForOne1', type: 'bool' },
      { name: 'zeroForOne2', type: 'bool' },
      { name: 'zeroForOne3', type: 'bool' },
      { name: 'exactOutputAmount', type: 'uint256' },  // Exact output amount from Pool1 (số dương)
      { name: 'sqrtPriceLimit1', type: 'uint160' },
      { name: 'sqrtPriceLimit2', type: 'uint160' },
      { name: 'sqrtPriceLimit3', type: 'uint160' },
      { name: 'minProfit', type: 'uint256' },
      { name: 'tipAmount', type: 'uint256' },
    ],
    outputs: [],
  },
];

// Constants for sqrt price limits (from TickMath)
export const MIN_SQRT_RATIO = '4295128740';  // MIN_SQRT_RATIO + 1
export const MAX_SQRT_RATIO = '1461446703485210103287273052203988822378723970341';  // MAX_SQRT_RATIO - 1

