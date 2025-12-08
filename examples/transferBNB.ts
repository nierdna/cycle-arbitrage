/**
 * Script: Transfer BNB to wallets in config
 * 
 * Chức năng:
 * - Đọc các ví từ tokens.config.json
 * - Kiểm tra số dư BNB của mỗi ví
 * - Transfer BNB nếu số dư chưa đủ lượng tối thiểu
 * 
 * Usage:
 *   1. Set environment variables:
 *      BSC_RPC_URL=https://bsc-dataseed.binance.org/
 *      PRIVATE_KEY=0x... (ví nguồn để transfer)
 *      MIN_BNB_AMOUNT=0.01 (lượng BNB tối thiểu, default: 0.01 BNB)
 *      TRANSFER_AMOUNT=0.1 (lượng BNB transfer mỗi lần, default: 0.1 BNB)
 *      TOKENS_CONFIG_PATH=./tokens.config.json (optional)
 *   2. npm run transfer:bnb hoặc tsx examples/transferBNB.ts
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { loadWalletKeysFromConfig } from '../src/tokens/index.js';
import { DEFAULT_RPC_URLS } from 'uniswap-v3-quoter';

interface TransferResult {
  walletAddress: string;
  currentBalance: string;
  needsTransfer: boolean;
  transferTxHash?: string;
  error?: string;
}

async function main() {
  console.log('=== Transfer BNB to Wallets ===\n');

  // Setup provider
  const rpcUrl = process.env.BSC_RPC_URL || DEFAULT_RPC_URLS.BSC_MAINNET;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`RPC: ${rpcUrl}\n`);

  // Load config
  const configPath = process.env.TOKENS_CONFIG_PATH;
  if (configPath) {
    console.log(`Using tokens config: ${configPath}\n`);
  }

  // Load wallet keys from config
  let walletPrivateKeys: string[] = [];
  try {
    walletPrivateKeys = loadWalletKeysFromConfig(configPath);
    if (walletPrivateKeys.length === 0) {
      console.error('No wallet keys found in config file');
      process.exit(1);
    }
    console.log(`Loaded ${walletPrivateKeys.length} wallet key(s) from config file\n`);
  } catch (error) {
    console.error('Failed to load wallet keys from config file:', error);
    process.exit(1);
  }

  // Get source wallet for transfer
  const sourcePrivateKey = process.env.PRIVATE_KEY;
  if (!sourcePrivateKey) {
    console.error('PRIVATE_KEY not set in environment variables');
    process.exit(1);
  }

  let sourceWallet: ethers.Wallet;
  try {
    sourceWallet = new ethers.Wallet(sourcePrivateKey, provider);
    console.log(`Source wallet: ${sourceWallet.address}\n`);
  } catch (error) {
    console.error('Invalid source wallet private key:', error);
    process.exit(1);
  }

  // Get minimum BNB amount (default: 0.01 BNB)
  const minBNBAmountStr = process.env.MIN_BNB_AMOUNT || '0.01';
  const minBNBAmount = ethers.parseEther(minBNBAmountStr);
  console.log(`Minimum BNB amount: ${ethers.formatEther(minBNBAmount)} BNB\n`);

  // Get transfer amount (default: 0.1 BNB)
  const transferAmountStr = process.env.TRANSFER_AMOUNT || '0.1';
  const transferAmount = ethers.parseEther(transferAmountStr);
  console.log(`Transfer amount per wallet: ${ethers.formatEther(transferAmount)} BNB\n`);

  // Check source wallet balance
  const sourceBalance = await provider.getBalance(sourceWallet.address);
  console.log(`Source wallet balance: ${ethers.formatEther(sourceBalance)} BNB`);
  
  // Estimate gas cost (approximate: 21000 gas * gas price)
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || BigInt(0);
  const estimatedGasCost = BigInt(21000) * gasPrice;
  const totalNeeded = transferAmount + estimatedGasCost;
  
  console.log(`Estimated gas cost per transfer: ${ethers.formatEther(estimatedGasCost)} BNB`);
  console.log(`Total needed per transfer: ${ethers.formatEther(totalNeeded)} BNB\n`);

  if (sourceBalance < totalNeeded) {
    console.warn(`⚠ Warning: Source wallet may not have enough BNB for all transfers`);
    console.warn(`  Balance: ${ethers.formatEther(sourceBalance)} BNB`);
    console.warn(`  Needed per transfer: ${ethers.formatEther(totalNeeded)} BNB\n`);
  }

  // Create wallets from private keys
  const wallets = walletPrivateKeys.map((pk) => new ethers.Wallet(pk, provider));
  
  console.log('Checking wallet balances...\n');
  const results: TransferResult[] = [];

  // Check each wallet balance
  for (const wallet of wallets) {
    const address = wallet.address;
    const balance = await provider.getBalance(address);
    const balanceBNB = ethers.formatEther(balance);
    const needsTransfer = balance < minBNBAmount;

    console.log(`Wallet: ${address}`);
    console.log(`  Balance: ${balanceBNB} BNB`);
    console.log(`  Needs transfer: ${needsTransfer ? 'YES' : 'NO'}`);

    if (needsTransfer) {
      // Check if source wallet has enough balance
      const currentSourceBalance = await provider.getBalance(sourceWallet.address);
      if (currentSourceBalance < totalNeeded) {
        const error = `Source wallet insufficient balance: ${ethers.formatEther(currentSourceBalance)} BNB < ${ethers.formatEther(totalNeeded)} BNB`;
        console.log(`  ❌ ${error}\n`);
        results.push({
          walletAddress: address,
          currentBalance: balanceBNB,
          needsTransfer: true,
          error,
        });
        continue;
      }

      try {
        // Send transaction
        console.log(`  Transferring ${ethers.formatEther(transferAmount)} BNB...`);
        const tx = await sourceWallet.sendTransaction({
          to: address,
          value: transferAmount,
        });

        console.log(`  Transaction hash: ${tx.hash}`);
        console.log(`  Waiting for confirmation...`);

        // Wait for transaction confirmation
        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) {
          console.log(`  ✅ Transfer successful!`);
          console.log(`  Gas used: ${receipt.gasUsed.toString()}\n`);

          // Verify new balance
          const newBalance = await provider.getBalance(address);
          const newBalanceBNB = ethers.formatEther(newBalance);
          console.log(`  New balance: ${newBalanceBNB} BNB\n`);

          results.push({
            walletAddress: address,
            currentBalance: balanceBNB,
            needsTransfer: true,
            transferTxHash: tx.hash,
          });
        } else {
          throw new Error('Transaction failed');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`  ❌ Transfer failed: ${errorMsg}\n`);
        results.push({
          walletAddress: address,
          currentBalance: balanceBNB,
          needsTransfer: true,
          error: errorMsg,
        });
      }
    } else {
      console.log('');
      results.push({
        walletAddress: address,
        currentBalance: balanceBNB,
        needsTransfer: false,
      });
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  const needsTransferCount = results.filter((r) => r.needsTransfer).length;
  const transferredCount = results.filter((r) => r.transferTxHash).length;
  const failedCount = results.filter((r) => r.needsTransfer && !r.transferTxHash).length;
  const skippedCount = results.filter((r) => !r.needsTransfer).length;

  console.log(`Total wallets: ${results.length}`);
  console.log(`Needs transfer: ${needsTransferCount}`);
  console.log(`Transferred: ${transferredCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Skipped (sufficient balance): ${skippedCount}`);

  if (transferredCount > 0) {
    console.log('\nSuccessful transfers:');
    results
      .filter((r) => r.transferTxHash)
      .forEach((r) => {
        console.log(`  ${r.walletAddress}: ${r.transferTxHash}`);
      });
  }

  if (failedCount > 0) {
    console.log('\nFailed transfers:');
    results
      .filter((r) => r.needsTransfer && !r.transferTxHash)
      .forEach((r) => {
        console.log(`  ${r.walletAddress}: ${r.error || 'Unknown error'}`);
      });
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

