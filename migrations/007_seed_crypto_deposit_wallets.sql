-- Seed Monarch Codex's approved crypto deposit destinations.
-- Apply once in phpMyAdmin after migrations/006_deposit_payment_workflow.sql.
-- Crypto destinations are listed under USD deposits; all are active and editable in Admin > Deposits.
-- Re-running this migration updates matching asset/network records and does not create duplicates.

START TRANSACTION;

UPDATE deposit_payment_methods
SET currency='USD', label='Bitcoin (BTC)', wallet_network='Bitcoin', wallet_asset='BTC',
    wallet_address='bc1qge4zruwxfr79ue5uq485zv79mnry8hpszmt5nz',
    instructions='Send BTC on the Bitcoin network only. Check the address and network before confirming the transfer.', is_active=1
WHERE method_type='wallet' AND wallet_asset='BTC' AND wallet_network='Bitcoin';

INSERT INTO deposit_payment_methods (method_type,currency,label,wallet_network,wallet_asset,wallet_address,instructions,is_active)
SELECT 'wallet','USD','Bitcoin (BTC)','Bitcoin','BTC','bc1qge4zruwxfr79ue5uq485zv79mnry8hpszmt5nz',
       'Send BTC on the Bitcoin network only. Check the address and network before confirming the transfer.',1
WHERE NOT EXISTS (SELECT 1 FROM deposit_payment_methods WHERE method_type='wallet' AND wallet_asset='BTC' AND wallet_network='Bitcoin');

UPDATE deposit_payment_methods
SET currency='USD', label='Ethereum (ETH)', wallet_network='Ethereum (ERC-20)', wallet_asset='ETH',
    wallet_address='0x854A199f5AF3804430EF0c8178868Ee29987BBD3',
    instructions='Send ETH on Ethereum mainnet (ERC-20) only. Do not send using another network.', is_active=1
WHERE method_type='wallet' AND wallet_asset='ETH' AND wallet_network='Ethereum (ERC-20)';

INSERT INTO deposit_payment_methods (method_type,currency,label,wallet_network,wallet_asset,wallet_address,instructions,is_active)
SELECT 'wallet','USD','Ethereum (ETH)','Ethereum (ERC-20)','ETH','0x854A199f5AF3804430EF0c8178868Ee29987BBD3',
       'Send ETH on Ethereum mainnet (ERC-20) only. Do not send using another network.',1
WHERE NOT EXISTS (SELECT 1 FROM deposit_payment_methods WHERE method_type='wallet' AND wallet_asset='ETH' AND wallet_network='Ethereum (ERC-20)');

UPDATE deposit_payment_methods
SET currency='USD', label='Tether (USDT TRC-20)', wallet_network='TRON (TRC-20)', wallet_asset='USDT',
    wallet_address='TKPv8GPQyimasyRA71jAKju7ZGm2o2YXmc',
    instructions='Send USDT using the TRON TRC-20 network only. Do not send TRC-20 USDT over another network.', is_active=1
WHERE method_type='wallet' AND wallet_asset='USDT' AND wallet_network='TRON (TRC-20)';

INSERT INTO deposit_payment_methods (method_type,currency,label,wallet_network,wallet_asset,wallet_address,instructions,is_active)
SELECT 'wallet','USD','Tether (USDT TRC-20)','TRON (TRC-20)','USDT','TKPv8GPQyimasyRA71jAKju7ZGm2o2YXmc',
       'Send USDT using the TRON TRC-20 network only. Do not send TRC-20 USDT over another network.',1
WHERE NOT EXISTS (SELECT 1 FROM deposit_payment_methods WHERE method_type='wallet' AND wallet_asset='USDT' AND wallet_network='TRON (TRC-20)');

UPDATE deposit_payment_methods
SET currency='USD', label='BNB (BEP-20)', wallet_network='BNB Smart Chain (BEP-20)', wallet_asset='BNB',
    wallet_address='0x854A199f5AF3804430EF0c8178868Ee29987BBD3',
    instructions='Send BNB using BNB Smart Chain (BEP-20) only. This address is also used for ETH, but the networks are different. Confirm the selected network carefully.', is_active=1
WHERE method_type='wallet' AND wallet_asset='BNB' AND wallet_network='BNB Smart Chain (BEP-20)';

INSERT INTO deposit_payment_methods (method_type,currency,label,wallet_network,wallet_asset,wallet_address,instructions,is_active)
SELECT 'wallet','USD','BNB (BEP-20)','BNB Smart Chain (BEP-20)','BNB','0x854A199f5AF3804430EF0c8178868Ee29987BBD3',
       'Send BNB using BNB Smart Chain (BEP-20) only. This address is also used for ETH, but the networks are different. Confirm the selected network carefully.',1
WHERE NOT EXISTS (SELECT 1 FROM deposit_payment_methods WHERE method_type='wallet' AND wallet_asset='BNB' AND wallet_network='BNB Smart Chain (BEP-20)');

UPDATE deposit_payment_methods
SET currency='USD', label='Solana (SOL)', wallet_network='Solana', wallet_asset='SOL',
    wallet_address='68JJSktMwCmKADyNTQbBeyTkWTvZN1YtUTkocmdc2NJm',
    instructions='Send SOL on the Solana network only. Check the address and network before confirming the transfer.', is_active=1
WHERE method_type='wallet' AND wallet_asset='SOL' AND wallet_network='Solana';

INSERT INTO deposit_payment_methods (method_type,currency,label,wallet_network,wallet_asset,wallet_address,instructions,is_active)
SELECT 'wallet','USD','Solana (SOL)','Solana','SOL','68JJSktMwCmKADyNTQbBeyTkWTvZN1YtUTkocmdc2NJm',
       'Send SOL on the Solana network only. Check the address and network before confirming the transfer.',1
WHERE NOT EXISTS (SELECT 1 FROM deposit_payment_methods WHERE method_type='wallet' AND wallet_asset='SOL' AND wallet_network='Solana');

COMMIT;
