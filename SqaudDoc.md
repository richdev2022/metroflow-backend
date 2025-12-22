Initiate Payment
This API lets you initiate transactions by making server calls that return a checkout URL. When visited, this URL will display our payment modal.
info
Environment base URL:

Test: https://sandbox-api-d.squadco.com

Production: https://api-d.squadco.com

Authorization keys are to be passed via Headers as a Bearer token.

Example: Authorization: Bearer sandbox_sk_94f2b798466408ef4d19e848ee1a4d1a3e93f104046f.

The transaction reference used to initiate transactions must be unique.

POST

sandbox-api.squadco.com/transaction/Initiate

cURL

Enter Payment details
Help us send transactions receipts to the customers

Charge Amount (₦)
e.g 10000
Customer Email Address
e.g example@email.com
Merchant key
e.g sandbox_sk_ec8d24ec25...
Send Request

curl --location 'https://sandbox-api.squadco.com/transaction/initiate'
--header 'Authorization: 47M3DMZD'
--header 'Content-Type: application/json'
--data-raw '{
"amount":_ ,
"email":_ ,
"key":\_ ,
"currency":"NGN",
"initiate_type": "inline",
"CallBack_URL" : "https://www.linkedin.com/",
}

POST
https://sandbox-api-d.squadco.com/transaction/initiate
This endpoint returns a checkout URL that when visited calls up the modal with the various payment channel.

Parameters
Header
Authorization\*

String

API keys (Secret Key) that authorize your transactions and gotten from your squad dashboard

Body
email\*

String

Customer's email address.

amount\*

String

The amount you are debiting customer (expressed in the lowest currency value - kobo& cent). 10000 = 100NGN for Naira Transactions

initiate_type\*

String

This states the method by which the transaction is initiated. At the moment, this can only take the value 'inline'.

currency\*

String

The currency you want the amount to be charged in. Allowed value is either NGN or USD.

transaction_ref

String

The merchant defined reference, unique for each transaction (where none is passed, a system-generated reference will be created)

customer_name

String

Name of Customer carrying out the transaction

callback_url

String

A web address where customers are redirected after payment completion (This differs from the URL where webhook notifications are sent).

payment_channels

Array

An array of payment channels to control what channels you want to make available for the user to make a payment with. Available channels include; ['card', 'bank' , 'ussd','transfer']

metadata

Object

Object that contains any additional information that you want to record with the transaction. The custom fields in the object will be returned via webhook and the payment verification endpoint.

pass_charge

Boolean

It takes two possible values: True or False. It is set to False by default. When set to True, the charges on the transaction is computed and passed on to the customer(payer). But when set to False, the charge is passed to the merchant and will be deducted from the amount to be settled to the merchant.

sub_merchant_id

String

This is the ID of a meerchant that was created by an aggregator which allows the aggregator initiate a transaction on behalf of the submerchant. This parameter is an optional field that is passed only by a registered aggregator

Responses
200:OK
Successful

401:Unauthorized
Invalid/No Authorization Key

400:Bad Request
Bad Request

Sample Request
{
"amount":43000,
"email":"henimastic@gmail.com",
"currency":"NGN",
"initiate_type": "inline",
"transaction_ref":"4678388588350909090AH",
"callback_url":"http://squadco.com"
}

Simulate Test Payment (Transfer)
In the test environment, when the transfer option is selected on the payment modal, a dynamic virtual account is created. To complete the transaction, a simulated payment is required. This API allows you to simulate a payment into the dynamic virtual account.

POST
https://sandbox-api-d.squadco.com/virtual-account/simulate/payment
This endpoint allows you simualte payment into an account

Parameters
Header
Authorization\*

String

API keys (Secret Key) that authorize your transactions and gotten from your squad dashboard

Body
virtual_account_number\*

Integer

Generated Dynamic Virtual Account from the Transfer modal

amount\*

Integer

The amount to be paid

Responses
200:OK
Successful
{

    "status": 200,
    "success": true,
    "message": "Success",
    "data": "Payment successful"

}

400:Bad Request
Bad Request
{
"status": "400",
"success": false,
"message": ""amount" is required",
"data": {}
}

Sample Request Simulate Payment
{
"virtual_account_number": "9279755518",
"amount": "20000"
}

Recurring Payment (Charge Authorization on Card)
This allows you charge a card without collecting the card information each time.

tip
For recurring Payments test on Sandbox, ensure to use the test card: 5200000000000007

Card Tokenization
Our system utilizes card tokenization, a security technique that replaces the customer's sensitive details with a unique, randomly generated token. This token can be safely stored and used for future transactions, eliminating the need to request the customer's card details again.

To tokenize a card, just add a flag to the initiate payload when calling the initiate endpoint and the card will automatically be tokenized. The unique token code will automatically be added to the webhook notification that will be received after payment.

"is_recurring":true

Sample Request for Card Tokenization
{
"amount":43000,
"email":"henimastic@gmail.com",
"currency":"NGN",
"initiate_type": "inline",
"transaction_ref":"bchs4678388588350909090AH",
"callback_url":"http://squadco.com",
"is_recurring":true
}

Sample Webhook Response For Tokenized Card
{
"Event": "charge_successful",
"TransactionRef": "SQTECH6389058547434300003",
"Body": {
"amount": 11000,
"transaction_ref": "SQTECH6389058547434300003",
"gateway_ref": "SQTECH6389058547434300003_1_6_1",
"transaction_status": "Success",
"email": "william@gmail.com",
"merchant_id": "SBSJ3KMH",
"currency": "NGN",
"transaction_type": "Card",
"merchant_amount": 868,
"created_at": "2025-08-12T10:51:14.368",
"meta": {
"details": "level1",
"location": "Lagos"
},
"payment_information": {
"payment_type": "card",
"pan": "509983**\*\***3911|1027",
"card_type": "mastercard",
"token_id": "AUTH_lBlGESHDLMX_60049043"
},
"is_recurring": true
}
}

Charge Card
This allows you charge a card using the token_id (The token_id is sent as part of the webhook on the first call).

POST
https://sandbox-api-d.squadco.com/transaction/charge_card
This debits a credit card using the token_id

Parameters
Body
amount\*

Integer

Amount to charge from card in the lowest currency value. kobo for NGN transactions or cent for USD transactions

token_id\*

String

A unique tokenization code for each card transaction and it is returned via the webhook for first charge on the card.

transaction_ref

String

Unique case-sensitive transaction reference. If you do not pass this parameter, Squad will generate a unique reference for you.

Responses
200:OK
Successful

400:Bad Request
Bad Request

Sample Request
{
"amount":10000,
"token_id":"tJlYMKcwPd",
}

Cancel Charge Card
This endpoint allows you to cancel a card which was previously tokenised.

PATCH
https://sandbox-api-d.squadco.com/transaction/cancel/recurring
This endpoint cancels active tokens

Parameters
Body
auth_code\*

String

Token ID sent via webhook at first tokenized call.

Responses
200:OK
Successful
{
"status": 200,
"success": true,
"message": "Success",
"data": {
"auth_code": [
"AUTH_lBlGXSHDLMX_63749043"
]
}
}
}

400:Bad Request
Bad Request
{
"status": 400,
"success": false,
"message": "Recurring Payment was not cancelled",
"data": {}
}

Sample Request
{
"auth_code": [
"AUTH_SlYtufQzy_452037"
]
}

Query All Transactions
This endpoint allows you to query all transactions and filter using multiple parameters like transaction ref, start and end dates, amount, etc

caution
The date parameters are compulsory and should be a maximum of one month gap. Requests without date parameters will fail with error 400: Bad request.

GET
https://sandbox-api-d.squadco.com/transaction
Parameters
Query
currency

string

transacting currency

start_date\*

date

start date of transaction

end_date\*

date

end date of transaction

page

integer

number of transactions to be displayed in a page

perpage

integer

number of transactions to be displayed in a page

reference

string

transaction ref of a transaction

Responses
200:OK
Success

400:Bad request
Bad Request

Go Live
To go live, simply:

Change the base URL of your endpoints from sandbox-api-d.squadco.com to api-d.squadco.com
Sign up on our Live Environment
Complete your KYC
Use the secret key provided on the dashboard to replace the test keys gotten from the sandbox environment to authenticate your live transactions.
