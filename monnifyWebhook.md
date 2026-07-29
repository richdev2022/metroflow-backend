Event types
Monnify supports webhooks for various events like card transactions, settlement and disbursement completion, and refunds. To implement webhooks on your Monnify integration, it is recommended to follow certain best practices such as validating transaction hash, whitelisting Monnify's IP address, checking for duplicate notifications, and processing complex logic after acknowledging receipt of the notification with a 200 HTTP status code. These practices ensure the integrity and security of the payload, prevent unauthorized requests, avoid redundant processing, and prevent time-out issues.

Monnify Webhook Events and Structure
As part of the Monnify integration, notifications are automatically sent to your system when certain actions are completed. These notifications trigger corresponding activities on your system, and you can specify URLs for certain activities on your integration. The notifications include an event-type property that indicates what action has taken place, as well as event data containing details of the event.


Supported notification event types on Monnify include


Successful Collection
For successful payments made on your account.

Sample Event Notification Structure
Copy
{
  "eventType": "SUCCESSFUL_TRANSACTION",
  "eventData": {
    "product": {
      "reference": "1636106097661",
      "type": "RESERVED_ACCOUNT"
    },
    "transactionReference": "MNFY|04|20211117112842|000170",
    "paymentReference": "MNFY|04|20211117112842|000170",
    "paidOn": "2021-11-17 11:28:42.615",
    "paymentDescription": "Adm",
    "metaData": {},
    "paymentSourceInformation": [
      {
        "bankCode": "",
        "amountPaid": 3000,
        "accountName": "Monnify Limited",
        "sessionId": "e6cV1smlpkwG38Cg6d5F9B2PRnIq5FqA",
        "accountNumber": "0065432190"
      }
    ],
    "destinationAccountInformation": {
      "bankCode": "232",
      "bankName": "Sterling bank",
      "accountNumber": "6000140770"
    },
    "amountPaid": 3000,
    "totalPayable": 3000,
    "cardDetails": {},
    "paymentMethod": "ACCOUNT_TRANSFER",
    "currency": "NGN",
    "settlementAmount": "2990.00",
    "paymentStatus": "PAID",
    "customer": {
      "name": "John Doe",
      "email": "test@tester.com"
    }
  }
}
Show more
Successful Disbursement
For disbursement transactions with a successful definite status.

Sample Event Notification Structure
Copy
{
  "eventType": "SUCCESSFUL_DISBURSEMENT",
  "eventData": {
    "amount": 10,
    "transactionReference": "MFDS|20210317032332|002431",
    "fee": 8,
    "transactionDescription": "Approved or completed successfully",
    "destinationAccountNumber": "0068687503",
    "sessionId": "090405210317032336726272971260",
    "createdOn": "17/03/2021 3:23:32 AM",
    "destinationAccountName": "DAMILARE SAMUEL OGUNNAIKE",
    "reference": "ref1615947809303",
    "destinationBankCode": "232",
    "completedOn": "17/03/2021 3:23:38 AM",
    "narration": "This is a quite long narration",
    "currency": "NGN",
    "destinationBankName": "Sterling bank",
    "status": "SUCCESS"
  }
}
Show more
Failed Disbursement
For failed disbursement transactions.

Sample Event Notification Structure
Copy
{
  "eventType": "FAILED_DISBURSEMENT",
  "eventData": {
    "amount": 17100,
    "transactionReference": "MFDS10620240708214001015343FR7PL8",
    "fee": 20,
    "transactionDescription": "You do not have sufficient balance to process this request. Please fund your account and try again.",
    "destinationAccountNumber": "8088524531",
    "sessionId": "",
    "createdOn": "08/07/2024 9:40:02 PM",
    "destinationAccountName": "MARVELOUS BENJI",
    "reference": "MF240708214000166415",
    "destinationBankCode": "305",
    "completedOn": "08/07/2024 9:40:07 PM",
    "narration": "AOlifepurse1260077196647628800Transaction",
    "currency": "NGN",
    "destinationBankName": "OPAY",
    "status": "FAILED"
  }
}
Show more
Reversed Disbursement
For reversed disbursement transactions.

Sample Event Notification Structure
Copy
{
  "eventType": "REVERSED_DISBURSEMENT",
  "eventData": {
    "transactionReference": "MFDS33920240513211815009133P47MKU",
    "reference": "662d2dcf22132ea227db164e-1715631494637",
    "narration": "Fund Transfer",
    "currency": "NGN",
    "amount": 145708,
    "status": "REVERSED",
    "fee": 8,
    "destinationAccountNumber": "8088523251",
    "destinationAccountName": "Marvelous Benji",
    "destinationBankCode": "305",
    "sessionId": "090405240513211816637369129129",
    "createdOn": "13/05/2023 9:18:16 PM",
    "completedOn": "13/05/2023 9:18:19 PM"
  }
}
Show more
Successful Refund
For successfully processed initiated refunds.

Sample Event Notification Structure
Copy
{
  "eventType": "SUCCESSFUL_REFUND",
  "eventData": {
    "merchantReason":"defective goods",
    "transactionReference":"MNFY|20190816083102|000021",
    "completedOn":"14/04/2021 4:24:05 PM",
    "refundStatus":"COMPLETED",
    "customerNote":"defects",
    "createdOn":"14/04/2021 4:23:37 PM",
    "refundReference":"ref001",
    "refundAmount":10:00
  }
}
Failed Refund
For failed initiated refunds.

Sample Event Notification Structure
Copy
{
  "eventType": "FAILED_REFUND",
  "eventData": {
    "merchantReason":"defective goods",
    "transactionReference":"MNFY|20190816083102|000021",
    "completedOn":"14/04/2021 4:24:05 PM",
    "refundStatus":"FAILED",
    "customerNote":"defects",
    "createdOn":"14/04/2021 4:23:37 PM",
    "refundReference":"ref001",
    "refundAmount":10:00
  }
} 
Settlement Completion
For successfully processed settlements to your bank account or wallet.

Sample Event Notification Structure
Copy
{
  "eventType": "SETTLEMENT",
  "eventData": {
    "amount": "1199.00",
    "settlementTime": "11/11/2021 02:29:00 PM",
    "settlementReference": "LB8HG1PNZT4ATJGZXQBY",
    "destinationAccountNumber": "6000000249",
    "destinationBankName": "Fidelity Bank",
    "destinationAccountName": "Teamapt Limited234",
    "transactionsCount": 1,
    "transactions": [
      {
        "product": {
          "reference": "2134565wda",
          "type": "2134565wda"
        },
        "transactionReference": "MNFY|26|20211111142601|000001",
        "paymentReference": "MNFY|26|20211111142601|000001",
        "paidOn": "11/11/2021 02:26:02 PM",
        "paymentDescription": "Seg",
        "accountPayments": [
          {
            "bankCode": "000014",
            "amountPaid": "1234.00",
            "accountName": "Okeke Chimezie",
            "accountNumber": "******1070"
          }
        ],
        "amountPaid": "1234.00",
        "totalPayable": "1234.00",
        "accountDetails": {
          "bankCode": "000014",
          "amountPaid": "1234.00",
          "accountName": "Okeke Chimezie",
          "accountNumber": "******1070"
        },
        "cardDetails": {},
        "paymentMethod": "ACCOUNT_TRANSFER",
        "currency": "NGN",
        "paymentStatus": "PAID",
        "customer": {
          "name": "Segun Adeponle",
          "email": "segunadeponle@gmail.com"
        }
      }
    ]
  }
}
Show more
Completed Offline Payments
Sample Event Notification Structure
Copy
{
  "eventType": "SUCCESSFUL_TRANSACTION",
  "eventData": {
    "product": {
      "reference": "MNF-Tl9Noo0G48000890",
      "type": "OFFLINE_PAYMENT_AGENT"
    },
    "transactionReference": "MNFY|76|20230830171357|000252",
    "invoiceReference": "MNF-Tl9Noo0G48000890",
    "paymentReference": "MNF-Tl9Noo0G48000890",
    "paidOn": "30/08/2023 5:13:57 PM",
    "paymentDescription": "adron",
    "metaData":{
      "phoneNumber":"08088523241",
      "name":"Khalid"
    },
    "destinationAccountInformation": {},
    "paymentSourceInformation": {},
    "amountPaid": 15000,
    "totalPayable": 15000,
    "offlineProductInformation": {
      "amount": 15000,
      "code": "56417",
      "type": "INVOICE"
    },
    "cardDetails": {},
    "paymentMethod": "CASH",
    "currency": "NGN",
    "settlementAmount": 14990,
    "paymentStatus": "PAID",
    "customer": {
      "name": "David Customer",
      "email": "mayluv55@hotmail.co.uk"
    }
  }
}
Show more
Rejected Payments
Sample Event Notification Structure
Copy
{
  "eventType": "REJECTED_PAYMENT",
  "eventData": {
    "metaData": "{"name":"Marvelous","age":"90"}",
    "product": {
      "reference": "MNFY|PAYREF|GENERATED|1687798434397393735",
      "type": "WEB_SDK"
    },
    "amount": 100,
    "paymentSourceInformation": {
      "bankCode": "50515",
      "amountPaid": 40,
      "accountName": "MARVELOUS BENJI",
      "sessionId": "090405230626180003067844645188",
      "accountNumber": "5141901487"
    },
    "transactionReference": "MNFY|85|20230626175354|041855",
    "created_on": "2023-06-26 17:53:55.0",
    "paymentReference": "MNFY|PAYREF|GENERATED|1687798434397393735",
    "paymentRejectionInformation": {
      "bankCode": "035",
      "destinationAccountNumber": "7023576853",
      "bankName": "Wema bank",
      "rejectionReason": "UNDER_PAYMENT",
      "expectedAmount": 100
    },
    "paymentDescription": "lets pay",
    "customer": {
      "name": "Marvelous Benji",
      "email": "benji71@gmail.com"
    }
  }
}
Show more
Mandate Status Change
Sample Event Notification Structure
Copy
{
  "eventType": "MANDATE_UPDATE",
  "eventData": {
    "customerAddress": "Everywhere is an address",
    "endDate": "2024-12-31 08:00:00.0",
    "customerEmailAddress": "ogunnaike.damilare@gmail.com",
    "customerAccountName": "SAMUEL DAMILARE OGUNNAIKE",
    "customerAccountNumber": "2191406799",
    "customerAccountBankCode": "057",
    "customerName": "Damilare Ogunnaike",
    "mandateDescription": "Testing Monnify Mandate",
    "externalMandateReference": "mfy-mandate-102",
    "mandateStatus": "CANCELLED",
    "mandateAmount": 100000,
    "autoRenew": false,
    "mandateCode": "MTDD|01J3GRJH8D58B20VNX1E6GSY1N",
    "contractCode": "626689863141",
    "customerPhoneNumber": "08166189142",
    "startDate": "2024-07-24 08:00:00.0"
  }
} 
Show more
Wallet Activity Notification
Sample Event Notification Structure
Copy
 {
  "eventType": "ACCOUNT_ACTIVITY",
  "eventData": {
    "accountType": "MAIN",
    "accountName": "Test01",
    "accountNumber": "8016472829",
    "accountNuban": null,
    "activityType": "TRANSACTION",
    "amount": 100,
    "currency": "566",
    "balanceBefore": 862.68,
    "balanceAfter": 962.68,
    "reference": "MFY_WTP_TRF_2MPT61CFP_1896839989128998912_CBA_CREDIT_0_CREDIT_0",
    "narration": " MFY-WT/#/TRF|2MPT61cfp|1896839989128998912_CBA_CREDIT_0/#/2025-03-04/#/VA-6927004623/#/From-Moniepoint Microfinance Bank/#/Test User/#/5744000051",
    "activityTime": "2025-03-04 10:27:AM"
  },
  "metaData": {
    "senderAccount": "Monnify Service",
    "sourceAccountName": null,
    "sourceAccountNumber": null,
    "sourceBankCode": null,
    "sourceBankName": null
  }
} 
Show more
Low Balance Alert
Sample Event Notification Structure
Copy
{
"eventType": "LOW_BALANCE_ALERT",
"eventData": {
  "transactionTime": "2025-09-01T23:13:19Z",
  "merchantCode": "99ZYAFM0F3CY",
  "walletAccountNumber": "8023759978",
  "walletBalance": 0,
  "lowBalanceThreshold": 2000,
  "currency": "NGN",
  "description": "Your wallet balance has dropped below the configured threshold. Please fund your account."
  }
}


Transaction Hash Computation
As a security measure, Monnify computes a hash of the request body whenever it sends a notification and includes it in the request header with the key 'monnify-signature'. To ensure the notification is valid and authorized, you should also calculate the hash and compare it to the one sent by Monnify before accepting or acting on the notification.

To calculate the hash, you can use a SHA-512 encoding of your client secret key and the object of the request body. The formula is: SHA-512(client secret key + object of request body).



Javascript, PHP, Java Sample Codes:
Sample Client Key: 91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y

Sample Request:

Sample Event Data
Copy
{
  "eventData": {
      "product": {
          "reference": "111222333",
          "type": "OFFLINE_PAYMENT_AGENT"
      },
      "transactionReference": "MNFY|76|20211117154810|000001",
      "paymentReference": "0.01462001097368737",
      "paidOn": "17/11/2021 3:48:10 PM",
      "paymentDescription": "Mockaroo Jesse",
      "metaData": {},
      "destinationAccountInformation": {},
      "paymentSourceInformation": {},
      "amountPaid": 78000,
      "totalPayable": 78000,
      "offlineProductInformation": {
          "code": "41470",
          "type": "DYNAMIC"
      },
      "cardDetails": {},
      "paymentMethod": "CASH",
      "currency": "NGN",
      "settlementAmount": 77600,
       "paymentStatus": "PAID",
      "customer": {
          "name": "Mockaroo Jesse",
          "email": "111222333@ZZAMZ4WT4Y3E.monnify"
      }
  },
  "eventType": "SUCCESSFUL_TRANSACTION"
}
Show more
Hashed Value:

f04fb635e04d71648bd3cc7999003da6861483342c856d05ddfa9b2dafacb873b0de1d0f8f67405d0010b4348b721c49fa171d317972618debba6b638aedcd3c

Computing Hash in Nodejs
Computing Hash in Nodejs
Copy
const { sha512 } = require("js-sha512");

const DEFAULT_MERCHANT_CLIENT_SECRET = "91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y";

/**
* Computes the HMAC-SHA512 hash of the given request body.
* @param {string} requestBody - The stringified request body (JSON payload).
* @returns {string} - The computed hash as a hex string.
*/
const computeHash = (requestBody) => {
return sha512.hmac(DEFAULT_MERCHANT_CLIENT_SECRET, requestBody);
};

// Sample request body payload
const stringifiedRequestBody = JSON.stringify(
{
  eventData: {
    product: {
      reference: "111222333",
      type: "OFFLINE_PAYMENT_AGENT",
    },
    transactionReference: "MNFY|76|20211117154810|000001",
    paymentReference: "0.01462001097368737",
    paidOn: "17/11/2021 3:48:10 PM",
    paymentDescription: "Mockaroo Jesse",
    metaData: {},
    destinationAccountInformation: {},
    paymentSourceInformation: {},
    amountPaid: 78000,
    totalPayable: 78000,
    offlineProductInformation: {
      code: "41470",
      type: "DYNAMIC",
    },
    cardDetails: {},
    paymentMethod: "CASH",
    currency: "NGN",
    settlementAmount: 77600,
    paymentStatus: "PAID",
    customer: {
      name: "Mockaroo Jesse",
      email: "111222333@ZZAMZ4WT4Y3E.monnify",
    },
  },
  eventType: "SUCCESSFUL_TRANSACTION",
},
null,
2 // pretty-print spacing (optional)
);

const computedHash = computeHash(stringifiedRequestBody);
console.log("Computed hash:", computedHash);
Show more
Computing Hash in PHP
Computing Hash in Nodejs
Copy
<?php

class CustomTransactionHashUtil
{
  /**
   * Computes an HMAC-SHA512 hash for a given JSON string and client secret.
   *
   * @param string $stringifiedData The stringified JSON payload.
   * @param string $clientSecret    The merchant client secret.
   *
   * @return string The computed HMAC-SHA512 hash.
   */
  public static function computeSHA512TransactionHash(string $stringifiedData, string $clientSecret): string
  {
      return hash_hmac('sha512', $stringifiedData, $clientSecret);
  }
}

$DEFAULT_MERCHANT_CLIENT_SECRET = '91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y';

// Build the payload as an array (safer and more readable)
$payload = [
  "eventData" => [
      "product" => [
          "reference" => "111222333",
          "type" => "OFFLINE_PAYMENT_AGENT",
      ],
      "transactionReference" => "MNFY|76|20211117154810|000001",
      "paymentReference" => "0.01462001097368737",
      "paidOn" => "17/11/2021 3:48:10 PM",
      "paymentDescription" => "Mockaroo Jesse",
      "metaData" => new stdClass(),
      "destinationAccountInformation" => new stdClass(),
      "paymentSourceInformation" => new stdClass(),
      "amountPaid" => 78000,
      "totalPayable" => 78000,
      "offlineProductInformation" => [
          "code" => "41470",
          "type" => "DYNAMIC",
      ],
      "cardDetails" => new stdClass(),
      "paymentMethod" => "CASH",
      "currency" => "NGN",
      "settlementAmount" => 77600,
      "paymentStatus" => "PAID",
      "customer" => [
          "name" => "Mockaroo Jesse",
          "email" => "111222333@ZZAMZ4WT4Y3E.monnify",
      ],
  ],
  "eventType" => "SUCCESSFUL_TRANSACTION",
];

// Convert payload to JSON (stringified body)
$stringifiedData = json_encode($payload, JSON_UNESCAPED_SLASHES);

// Compute hash
$computedHash = CustomTransactionHashUtil::computeSHA512TransactionHash(
  $stringifiedData,
  $DEFAULT_MERCHANT_CLIENT_SECRET
);

echo "Computed Hash: " . $computedHash . PHP_EOL;
Show more
Computing Hash in Java
Computing Hash in Java
Copy
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.security.SignatureException;
import java.util.Formatter;

public class TransactionHashUtil {

  private static final String HMAC_SHA512 = "HmacSHA512";

  /**
   * Converts a byte array to a lowercase hex string.
   *
   * @param bytes The byte array to convert.
   * @return The hex string.
   */
  private static String toHexString(byte[] bytes) {
      try (Formatter formatter = new Formatter()) {
          for (byte b : bytes) {
              formatter.format("%02x", b);
          }
          return formatter.toString();
      }
  }

  /**
   * Computes an HMAC-SHA512 hash for the given payload using the merchant client secret.
   *
   * @param data                 The stringified JSON payload.
   * @param merchantClientSecret The merchant client secret.
   * @return The computed HMAC-SHA512 hash as a lowercase hex string.
   *
   * @throws SignatureException       If signature computation fails.
   * @throws NoSuchAlgorithmException If HmacSHA512 algorithm is not available.
   * @throws InvalidKeyException      If the provided key is invalid.
   */
  public static String computeHMAC512TransactionHash(String data, String merchantClientSecret)
          throws SignatureException, NoSuchAlgorithmException, InvalidKeyException {

      SecretKeySpec secretKeySpec = new SecretKeySpec(
              merchantClientSecret.getBytes(StandardCharsets.UTF_8),
              HMAC_SHA512
      );

      Mac mac = Mac.getInstance(HMAC_SHA512);
      mac.init(secretKeySpec);

      byte[] rawHmac = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
      return toHexString(rawHmac);
  }

  // Example usage
  public static void main(String[] args) {
      String clientSecret = "91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y";
      String requestBody = "{"eventData":{"product":{"reference":"111222333","type":"OFFLINE_PAYMENT_AGENT"},"transactionReference":"MNFY|76|20211117154810|000001","paymentReference":"0.01462001097368737","paidOn":"17/11/2021 3:48:10 PM","paymentDescription":"Mockaroo Jesse","metaData":{},"destinationAccountInformation":{},"paymentSourceInformation":{},"amountPaid":78000,"totalPayable":78000,"offlineProductInformation":{"code":"41470","type":"DYNAMIC"},"cardDetails":{},"paymentMethod":"CASH","currency":"NGN","settlementAmount":77600,"paymentStatus":"PAID","customer":{"name":"Mockaroo Jesse","email":"111222333@ZZAMZ4WT4Y3E.monnify"}},"eventType":"SUCCESSFUL_TRANSACTION"}";

      try {
          String hash = computeHMAC512TransactionHash(requestBody, clientSecret);
          System.out.println("Computed Hash: " + hash);
      } catch (Exception e) {
          e.printStackTrace();
      }
  }
}
Show more
