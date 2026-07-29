Bulk Transfers
The Monnify Bulk Transfer API allows you to send money to multiple recipients in a single request. Each entry in the batch is processed individually, and you receive a consolidated status for the entire batch. This guide walks you through the prerequisites and the full integration flow.


alert image
Making Bulk Disbursement From UI
You can perform a bulk transfer directly from your Monnify dashboard. Simply click on Bulk Transfer, download the provided template, and fill in the necessary details. Once, a response is gotten, there are two possible responses that can be gotten.
Before You Begin
Before integrating the Bulk Transfer API, make sure you have completed the following steps:


Enable Disbursements on your account
Disbursements is not enabled by default on Monnify. You must request activation for the feature to enabled on their account for either Sandbox and/or Live environment by contacting integration-support@monnify.com to get this enabled before you can make any transfer requests.

Whitelist your server IP address
For security on Live environment, Monnify only processes disbursement requests from whitelisted IP addresses. You must provide the static IP address(es) of your server(s) to Monnify before going live. If your IP is not whitelisted, all disbursement requests will be rejected with a D06 error. Send your IP address(es) to integration-support@monnify.com to get them added.

Understand how MFA (OTP) works
Multi-Factor Authentication (MFA) via OTP is enabled by default for all disbursement accounts in both Sandbox and Live instances. When MFA is active, each transfer request will return a PENDING_AUTHORIZATION status and require you to submit an OTP before the transfer is processed. The OTP is sent to the registered email address on your Monnify account.

If your integration handles transfers programmatically and you do not need OTP authorization, you can request for MFA to be disabled by contacting integration-support@monnify.com.

alert image
Note
You can merge and send the three requests above as a single email. As part of the email, you will be expected to indemnify Monnify for potential use and misuse of the feature as it pertains to your wallet balance with us.

Integration Flow
Once your account is set up, here is the typical flow for a bulk transfer:


Initiate the bulk transfer: your server sends a batch request to Monnify with a list of transactions (Maximun of 5000).
If MFA is enabled, authorize the batch by submitting the OTP received via email.
Poll the batch status or receive webhook notifications as individual transactions are processed.

Initiating a Bulk Transfer
Make a POST request to the Initiate Transfer (Bulk) API with your batch details. The response will differ depending on whether MFA is enabled on your account.

alert image
Use the right account details
Before initiating a bulk transfer, use the Name Enquiry API to look up and verify each recipient's account. The name returned should be passed as the destinationAccountName for each entry. Submitting a mismatched name will cause that transaction to fail. To get the correct destinationBankCode, use the Get Banks API to retrieve the full list of supported banks and their codes.

cURL
JavaScript
Python
PHP
Copy
curl --request POST \
--url https://sandbox.monnify.com/api/v2/disbursements/batch \
--header 'Authorization: Bearer {access_token}' \
--header 'Content-Type: application/json' \
--data '{
  "title": "October Salary Payment",
  "batchReference": "unique-batch-ref-001",
  "narration": "October salary disbursement",
  "sourceAccountNumber": "9999999999",
  "onValidationFailure": "CONTINUE", //or BREAK.
  "notificationInterval": 25,
  "transactionList": [
    {
      "amount": 50000.00,
      "reference": "unique-ref-001",
      "narration": "Salary - John Doe",
      "destinationBankCode": "058",
      "destinationAccountNumber": "0123456789",
      "destinationAccountName": "John Doe",
      "currency": "NGN"
    },
    {
      "amount": 75000.00,
      "reference": "unique-ref-002",
      "narration": "Salary - Jane Smith",
      "destinationBankCode": "044",
      "destinationAccountNumber": "9876543210",
      "destinationAccountName": "Jane Smith",
      "currency": "NGN"
    }
  ]
}'
Show more
alert image
Validation Status Options
The onValidationFailure field expects either BREAK or CONTINUE. BREAK means the request should stop the moment an account validation fails, CONTINUE means to skip the specific account number that failed validation and continue the execution of the request.

Response (MFA enabled, OTP required):

Response (MFA enabled)
Copy
{
"requestSuccessful": true,
"responseMessage": "success",
"responseCode": "0",
"responseBody": {
  "totalAmount": 125000.00,
  "totalFee": 100.00,
  "batchReference": "unique-batch-ref-001",
  "batchStatus": "PENDING_AUTHORIZATION",
  "dateCreated": "2024-01-15T10:30:00.000+0000",
  "totalTransactions": 2,
  "sourceAccountNumber": "9999999999"
}
}
Response (MFA disabled, batch proceeds immediately):

Response (MFA disabled)
Copy
{
"requestSuccessful": true,
"responseMessage": "success",
"responseCode": "0",
"responseBody": {
  "totalAmount": 125000.00,
  "totalFee": 100.00,
  "batchReference": "unique-batch-ref-001",
  "batchStatus": "AWAITING_PROCESSING",
  "dateCreated": "2024-01-15T10:30:00.000+0000",
  "totalTransactions": 2,
  "sourceAccountNumber": "9999999999"
}
}

Authorizing a Bulk Transfer (MFA / OTP)
If your account has MFA enabled and you received a PENDING_AUTHORIZATION batch status, you must authorize the batch by submitting the OTP sent to your registered email. Make a POST request to the Authorize Transfer (Bulk) API.


cURL
JavaScript
Python
PHP
Copy
curl --request POST \
--url https://sandbox.monnify.com/api/v2/disbursements/batch/validate-otp \
--header 'Authorization: Bearer {access_token}' \
--header 'Content-Type: application/json' \
--data '{
  "reference": "unique-batch-ref-001",
  "authorizationCode": "123456"
}'
Authorization Response
Copy
{
"requestSuccessful": true,
"responseMessage": "success",
"responseCode": "0",
"responseBody": {
  "totalAmount": 125000.00,
  "totalFee": 100.00,
  "batchReference": "unique-batch-ref-001",
  "batchStatus": "AWAITING_PROCESSING",
  "dateCreated": "2024-01-15T10:30:00.000+0000",
  "totalTransactions": 2,
  "sourceAccountNumber": "9999999999"
}
}

Resending an OTP
If the OTP was not received or has expired, you can request a new one via the Resend OTP API.


cURL
JavaScript
Python
PHP
Copy
curl --request POST \
--url https://sandbox.monnify.com/api/v2/disbursements/single/resend-otp \
--header 'Authorization: Bearer {access_token}' \
--header 'Content-Type: application/json' \
--data '{
  "reference": "unique-batch-ref-001"
}'

Getting Bulk Transfer Status
To check the status of a batch, make a GET request to the Bulk Transfer Status API with the batch reference.


cURL
JavaScript
Python
PHP
Copy
curl --request GET \
--url 'https://sandbox.monnify.com/api/v2/disbursements/bulk/summary?batchReference=unique-batch-ref-001' \
--header 'Authorization: Bearer {access_token}'
Bulk Transfer Status Response
Copy
{
"requestSuccessful": true,
"responseMessage": "success",
"responseCode": "0",
"responseBody": {
  "batchReference": "unique-batch-ref-001",
  "batchStatus": "COMPLETED",
  "totalTransactions": 2,
  "totalAmount": 125000.00,
  "totalFee": 100.00,
  "successfulCount": 2,
  "failedCount": 0,
  "pendingCount": 0,
  "dateCreated": "2024-01-15T10:30:00.000+0000",
  "sourceAccountNumber": "9999999999"
}
}
Show more

Getting Bulk Transfer Transactions
To retrieve a paginated list of all individual transactions within a batch and their statuses, make a GET request to the Get Bulk Transfer Transactions API. Provide pageNo (starts at 0) and pageSize as query parameters.


cURL
JavaScript
Python
PHP
Copy
curl --request GET \
--url 'https://sandbox.monnify.com/api/v2/disbursements/bulk/transactions?batchReference=unique-batch-ref-001&pageNo=0&pageSize=20' \
--header 'Authorization: Bearer {access_token}'

Searching Disbursement Transactions
To search across all your disbursement transactions, make a GET request to the Search Disbursement Transactions API. You can filter by reference, status, date range, and more.


Getting Your Wallet Balance
You can check the available balance in your Monnify disbursement wallet at any time by making a GET request to the Wallet Balance API.


cURL
JavaScript
Python
PHP
Copy
curl --request GET \
--url 'https://sandbox.monnify.com/api/v2/disbursements/wallet-balance?accountNumber=9999999999' \
--header 'Authorization: Bearer {access_token}'
Wallet Balance Response
Copy
{
"requestSuccessful": true,
"responseMessage": "success",
"responseCode": "0",
"responseBody": {
  "availableBalance": 24500.00,
  "ledgerBalance": 25000.00,
  "accountNumber": "9999999999",
  "currency": "NGN"
}
}

Batch Status Reference
Status	Description
PENDING_AUTHORIZATION	
MFA is enabled and the batch is waiting for OTP authorization before it can be processed.

OTP_EMAIL_DISPATCH_FAILED	
Monnify could not send the OTP email. Use the Resend OTP API to request a new one.

AWAITING_PROCESSING	
The batch has been authorized and is queued for processing.

IN_PROGRESS	
The batch is currently being processed. Individual transactions may complete at different times.

COMPLETED	
All transactions in the batch have been processed. Check individual transaction statuses for results.

FAILED_ON_ACCOUNTS_VALIDATION	
One or more transactions failed account validation. If onValidationFailure is set to BREAK, the entire batch is halted.

FAILED	
The batch could not be processed. Check the error message for the reason.


Transaction Status Reference
Status	Description
PENDING, AWAITING_PROCESSING and IN_PROGRESS

The transaction is still being processed. Re-query to get the final status.

SUCCESS and COMPLETED	
The disbursement was processed successfully and the recipient has been credited.

REVERSED	
The disbursement was reversed. The funds have been returned to your wallet.

FAILED	
The disbursement was not successful. Check the error message for the reason.

EXPIRED	
The transaction was not authorized within its validity period. Initiate a new transfer.


Error Reference
Error Code	Meaning	Recommended Action
99	
An unexpected error occurred while processing the transaction.

Re-query to confirm the transaction status before retrying.

D01	
Something went wrong and the transaction could not be processed. The actual error will be in the responseMessage field.

Treat as Failed.
D02	Transaction does not exist.	Treat as Failed.
D03	Invalid account details supplied.	Treat as Failed.
D04	Insufficient wallet balance.	Top up your Monnify wallet and retry.
D05	
The reference supplied has already been used for a previous transaction.

Retry with a new unique reference.
D06	
Unauthorized request. The request originated from an IP address that is not whitelisted.

Send your server IP address to integration-support@monnify.com for whitelisting.

D07	
Duplicate request. A transfer to the same account for the same amount was made within a 2-minute window.

Retry after 2 minutes, or contact integration-support@monnify.com to disable duplicate detection.

Invalid destination account number	
The account number did not pass name enquiry validation.

Ask the customer to provide a valid account number.

Dormant beneficiary account	The recipient's account is dormant.	The customer should contact their bank.
Beneficiary account name mismatch	The account name does not match the account number.	
Ask the customer to reconfirm their account details.

Unknown destination bank code	
The bank code supplied is not recognized on Monnify.

Confirm the correct destinationBankCode from the list of supported banks.

Transaction timed out while waiting for destination bank

The recipient's bank did not respond in time.	Re-query the transaction status.
Invalid amount	The transaction amount is invalid.	
Confirm the transaction amount and retry.

Delayed processing from NIP	Delay from the NIP (interbank network).	Re-query the transaction status.
Post No Credit restriction on beneficiary account

The recipient's account has a Post No Debit (PND) restriction and cannot be credited.

The customer should contact their bank.
Beneficiary bank not available	The recipient's bank is currently unavailable.	Re-query the transaction status.
Invalid session ID	The session ID for the transaction is invalid.	Re-query the transaction status.
Rejected by destination institution

The credit was rejected by the recipient's bank.

The customer should contact their bank to find out the reason.

Suspected fraud	
The recipient's account is under investigation for fraud.

The customer should contact their bank.
Invalid response code from beneficiary institution

An unrecognized response code was received from the recipient's bank.

Re-query the transaction status.
System malfunction by destination institution

The recipient's bank is experiencing a system issue.

Re-query the transaction status.
Beneficiary account limit exceeded	
The recipient's account is a low-KYC account and cannot receive the transfer amount.

The customer should contact their bank to upgrade their account tier.

Sender not permitted to credit beneficiary

The recipient's account has a restriction that prevents it from being credited.

The customer should contact their bank to identify and resolve the restriction.

Unable to complete the transaction at this time

The recipient's bank or payment provider is currently unavailable.

Re-query the transaction status.
Transaction could not be processed at this time. Please try again

The payment provider is currently unavailable.

Re-query the transaction status.
Transaction processing in progress	The transaction is still being processed.	Re-query the transaction status.
Account number could not be validated

Name enquiry failed: the account number may be invalid or the destination bank is unavailable.

Reconfirm the destination account details and check bank availability.

Transaction Failed	
The transaction failed due to a system or provider error.

Contact Monnify support.
System Malfunction - Internal service failure

The transaction failed due to an internal Monnify error.

Contact Monnify support.
System Malfunction - Transaction transmission unsuccessful

The transaction failed due to a system malfunction during transmission.

Contact Monnify support.
Processor Malfunction - Transaction transmission failed

An error occurred during transaction processing with NIBBS.

Re-query the transaction status.