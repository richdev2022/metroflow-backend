# API Specifications

{% hint style="danger" %}
**This documentation site has been deprecated as of September 8, 2025, and will no longer receive updates. Please refer to the new documentation site at** [**https://docs.squadco.com**](https://docs.squadco.com)**.**
{% endhint %}

## Specification For Virtual Accounts

### API KEYS (Test Environment)

1. Create an account on our sandbox environment: sandbox.squadco.com
2. Retrieve keys from the bottom of the Get Started Page&#x20;

{% hint style="warning" %}
**Authorization** Any request made without the authorization key will fail with a **`401`**` ``(Service Not Authorized)` response code.
{% endhint %}

{% hint style="info" %}
**Authorization** would be done via Headers using Keys gotten from your dashboard.&#x20;
{% endhint %}

**Example:**\
Authorizatio&#x6E;**:** Bearer sandbox\_sk\_94f2b798466408ef4d19e848ee1a4d1a3e93f104046f

This API specification helps you create a virtual account and also integrates payment reconciliation for your customers.

You can also trace payments to virtual accounts and link them up with customer details.

{% hint style="success" %}
**Reconciliation:** **For instant settlement when using our Virtual Account, All merchant and beneficiary accounts must be GTCO Bank Accounts.**&#x20;
{% endhint %}

### Creating Virtual Account

{% hint style="info" %}
**You need to make a POST Request to a dedicated endpoint** containing your customer information.
{% endhint %}

### IMPORTANT NOTICE

**Kindly share your preferred prefix with your Technical Account Manager to configure before going Live. The prefix must be a portion of your business name or an abbreviation of your business name as one word.**&#x20;

### Customer Model

**This endpoint is used to create virtual accounts for individuals/customers on your platform. Please note that there is a strict validation of the BVN against the names, Date of Birth and Phone Number. (B2C)**\
**The implication of this is that if any of the details mentioned above doesn't tally with what you have on the BVN passed, an account will not be generated.**\
**Please note that you can create virtual accounts for individuals regardless of the type of bank you provided during KYC.**

## Creating Virtual Accounts for Customers

<mark style="color:green;">`POST`</mark> `https://sandbox-api-d.squadco.com/virtual-account`

\*Asterisks are required and mandatory.

#### Request Body

| Name                                                   | Type   | Description                                                                                                                                          |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| first\_name<mark style="color:red;">\*</mark>          | String | customer first name                                                                                                                                  |
| mobile\_num<mark style="color:red;">\*</mark>          | String | 08012345678 (doesn't take more than 11 digits)                                                                                                       |
| dob<mark style="color:red;">\*</mark>                  | Date   | mm/dd/yyyy                                                                                                                                           |
| last\_name<mark style="color:red;">\*</mark>           | String | customer last name                                                                                                                                   |
| gender<mark style="color:red;">\*</mark>               | String | "1" - Male, "2" -Female                                                                                                                              |
| address<mark style="color:red;">\*</mark>              | String | customer address                                                                                                                                     |
| customer\_identifier<mark style="color:red;">\*</mark> | String | unique customer identifier as given by merchant                                                                                                      |
| middle\_name                                           | String | customer middle name                                                                                                                                 |
| email                                                  | String | customer email                                                                                                                                       |
| bvn<mark style="color:red;">\*</mark>                  | String | BVN is compulsory                                                                                                                                    |
| beneficiary\_account<mark style="color:red;">\*</mark> | String | **Beneficiary Account** is the 10 Digit Bank Account Number (GTBank) provided by the Merchant where money sent to this Virtual account is paid into. |

#### Sample Request

```
{
    "customer_identifier": "CCC",
    "first_name": "Joesph",
    "last_name": "Ayodele",
    "mobile_num": "08139011943",
    "email": "ayo@gmail.com",
    "bvn": "22110011001",
    "dob": "30/10/1990",
    "address": "22 Kota street, UK",
    "gender": "1",
    "beneficiary_account": "4920299492"
}
```

#### Sample Response

{% tabs %}
{% tab title="200: Successful" %}

```
{
    "success": true,
    "message": "Success",
    "data": {
        "first_name": "Joesph",
        "last_name": "Ayodele",
        "bank_code": "058",
        "virtual_account_number": "7834927713",
        "beneficiary_account": "4920299492",
        "customer_identifier": "CCC",
        "created_at": "2022-03-29T13:17:52.832Z",
        "updated_at": "2022-03-29T13:17:52.832Z"
    }
}
```

{% endtab %}

{% tab title="400: Validation Failure" %}

```
{
    "status": 400,
    "success": false,
    "message": "Validation Failure, Customer identifier is required",
    "data": {}
}

```

{% endtab %}

{% tab title="401: Restricted" %}
{\
&#x20;   "status": 401,\
&#x20;   "success": **false**,\
&#x20;   "message": "Merchant has been restricted, please contact Habaripay support",\
&#x20;   "data": {}\
}

{% endtab %}

{% tab title="404: Not Found" %}

```
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}

{% tab title="424: Identity Error" %}

```
{
"status": 424,
"message": "{"status":424,"success":false,"message":"Identity verification failed. Kindly pass a valid Id to continue","data":{}}",
"data": null
}
```

{% endtab %}
{% endtabs %}

### Business Model

This API allows you to create virtual accounts for your customers who are businesses and not individuals. That is, these customers are actually businesses **(B2B)** or other merchants.\
Please note that due to CBN's Guidelines on validation before account creation as well as other related Fraud concerns, you are required to request for profiling before you can have access to create accounts for businesses.\
Once profiled, you can go ahead and keep creating accounts for your businesses.\
\
**Please note that to create virtual accounts for BUSINESSES, your KYC account needs to be a GTB account number and is mapped to the BVN provided. This doesn't apply if you are creating for individuals.** &#x20;

#### Sample Request

```
{
    "customer_identifier": "CCC",
    "business_name": "Chicken Limited",
    "mobile_num": "08139011943",
    "bvn": "22110011001",
    "beneficiary_account": "4920299492"
}
```

## Creating Virtual Accounts for businesses

<mark style="color:green;">`POST`</mark> `https://sandbox-api-d.squadco.com/virtual-account/business`

#### Request Body

| Name                                                   | Type   | Description                                                                                                                        |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| bvn<mark style="color:red;">\*</mark>                  | String | Bank Verification Number                                                                                                           |
| business\_name<mark style="color:red;">\*</mark>       | String | Name of Business/Customer                                                                                                          |
| customer\_identifier<mark style="color:red;">\*</mark> | String | An alphanumeric string used to identify a customer/business in your system which will be tied to the virtual account being created |
| mobile\_num<mark style="color:red;">\*</mark>          | String | <p>Customer's Phone Number<br> Sample: 08012345678 (doesn't take more than 11 digits)</p>                                          |
| beneficiary\_account<mark style="color:red;">\*</mark> | String | **Beneficiary Account** is your 10 Digit Bank Account Number (GTBank) where money sent to this Virtual account is paid into.       |

{% tabs %}
{% tab title="400: Bad Request Bad Request" %}

```javascript
{
    "status": 400,
    "success": false,
    "message": "\"customer_identifier\" is required",
    "data": {}
}
```

{% endtab %}

{% tab title="200: OK Success" %}

```javascript
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "first_name": "Techzilla-Will",
        "last_name": "Okoye",
        "bank_code": "058",
        "virtual_account_number": "2474681469",
        "beneficiary_account": null,
        "customer_identifier": "Tech910260",
        "created_at": "2023-08-07T13:18:21.287Z",
        "updated_at": "2023-08-07T13:18:21.287Z"
    }
}
```

{% endtab %}

{% tab title="401: Unauthorized No API Key" %}

```javascript
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}

{% tab title="403: Forbidden Invalid Authorization key or token" %}

```javascript
{
    "success": false,
    "message": "Merchant authentication failed",
    "data": {}
}
```

{% endtab %}

{% tab title="424: Failed Dependency Wrong Account Number" %}

```
{
  "success": false,
  "message": "Validation Failure No record found for Account number- 1237398433",
  "data": {
    "first_name": null,
    "last_name": null,
    "bank_code": null,
    "virtual_account_number": null,
    "beneficiary_account": null,
    "customer_identifier": null,
    "created_at": "0001-01-01T00:00:00",
    "updated_at": "0001-01-01T00:00:00"
  },
  "status": "424"
}
```

{% endtab %}
{% endtabs %}

### Transaction Notification Service

Upon registration and verification as a merchant, you are to create a [Webhook and add on your Squad Dashboard](https://app.gitbook.com/s/-MdpY6mzS7POfcSmrF1z/webhook-and-redirect-url) to receive notification on payments.

{% hint style="warning" %}
**WEBHOOK**: If a webhook is not provided, notifications won't be sent.&#x20;
{% endhint %}

{% hint style="warning" %}
***KINDLY ENSURE YOU HAVE A TRANSACTION REFERENCE CHECKER WHEN IMPLEMENTING WEBHOOKS TO AVOID GIVING DOUBLE VALUE ON TRANSACTIONS.***
{% endhint %}

## Webhook Validation

### **Method 1 (Hash Comparison)**

The webhook notification sent carries the x-squad-signature in the header. The hash value (x-squad-signature) is an HMAC SHA512 signature of the webhook payload signed using your secret key.\
\
You are expected to create a hash and compare the value of the hash created with the hash sent in the header of the POST request sent to your webhook URL.\
\
To create the hash, you use the entire payload sent via the webhook.<br>

### Sample Implementations

{% tabs %}
{% tab title="C#" %}

```
using System;
using System.Text;
using System.Security.Cryptography;
using Newtonsoft.Json;
					
public class Program
{
	public static void Main()
	{
				var chargeResponse = new VirtualAccount_VM()
				{
					  transaction_reference = "REFE52ARZHTS/1668421222619_1",
					  virtual_account_number = "2129125316",
					  principal_amount = "222.00",
					  settled_amount = "221.78",
					  fee_charged = "0.22",
					  transaction_date = "2022-11-14T10:20:22.619Z",
					  customer_identifier = "SBN1EBZEQ8",
					  transaction_indicator = "C",
					  remarks =  "Transfer FROM sandbox sandbox | [SBN1EBZEQ8] TO sandbox sandbox",
					  currency = "NGN",
					  channel =  "virtual-account",
					  meta =  new MetaBody_VM()
					  {
						freeze_transaction_ref =  null,
						reason_for_frozen_transaction =  null
					  },
					  encrypted_body = "ViASuHLhO+SP3KtmcdAOis+3Obg54d5SgCFPFMcguYfkkYs/i44jeT5Dbx52TcOvHRp9HlnCoFwbATkEihzv2C8UyPoC38sRb90S5Z9Fq7vRwjDQz/hYi/nKbWA0btPr3A+UXhX1Nu5ek+TL0ENUC8W1ZX/FrowX3HQaYiwe3tU/Kfr2XvAGwT7IAx5CQBhpzL34faHP4jbwSVmSgVYmW5rd2ClWQ7WWJjDMakrqYJva8qd0vhkqSpyz2KywOV9t9zSHRx3VpbvlDsBdkNGr+4Axh/7Gspu3xo9mMOIdv73OzjN4VA/qQP+fQMCjU1pbS8oh81HjwkHjzC5SBhzR8IU8bsmvFUyzJMfDoJuUB+fs09SLW7pdfODwK5vB8LtdKPnAuTPlv5dHVAPeMG/ubtl/HOqCZs4axjuO557srw0GpKk86bwaVKt4IQ17nY/QCJFC273HWU1CawP7d3nQasRZf/TU7ra+fOjQBHQ7Gtz2Pnfp3gLljBKenMT4Cabks1X2/6ZQpd/yGFkloYdS7ZW3kEvrorjcyma4WNDmJfhcdR9XGsom6Y/M/n/gMMa0z2KPbHDRoEBeRYbQHcnu5LnGWzBA4Y4RMSTDesD876PDB1bOnMzNPrWYam6ZVRHz"
				};
				
				String SerializedPayload = JsonConvert.SerializeObject(chargeResponse);
				Console.WriteLine(SerializedPayload);
                string result = "";
                var secretKeyBytes = Encoding.UTF8.GetBytes("sandbox_sk_9ac9418e847972dd45f5fe845b5716ef305589808eda");
                var inputBytes = Encoding.UTF8.GetBytes(SerializedPayload);
                var hmac = new HMACSHA512(secretKeyBytes);
                byte[] hashValue = hmac.ComputeHash(inputBytes);
                result = BitConverter.ToString(hashValue).Replace("-", string.Empty);
				Console.WriteLine(result);
		
				Console.WriteLine(result.ToLower() == "18b9eb6ca68f92ca9f058da7bce6545efb12660cf75f960e552cf6098bb5ee8e71f20331dcfe0dfaea07439cc6629f901850291a39f374a1bd076c4eff1026c8");
	}
}
public class VirtualAccount_VM
{
  public string transaction_reference { get; set; }
  public string virtual_account_number { get; set; }
  public string principal_amount { get; set; }
  public string settled_amount { get; set; }
  public string fee_charged { get; set; }
  public string transaction_date { get; set; }
  public string customer_identifier { get; set; }
  public string transaction_indicator { get; set; }
  public string remarks { get; set; }
  public string currency { get; set; }
  public string channel { get; set; }
  public MetaBody_VM meta { get; set; }
  public string encrypted_body { get; set; }
}
public class MetaBody_VM
    {
        public string freeze_transaction_ref { get; set; }
        public string reason_for_frozen_transaction { get; set; }
    }
```

{% endtab %}

{% tab title="Javascript (Node)" %}

```
const crypto = require('crypto');
const secret = "Your Squad Secret Key";
// Using Express
app.post("/MY-WEBHOOK-URL", function(req, res) {
    //validate event
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    if (hash == req.headers['x-squad-signature']) {
     // you can trust the event came from squad and so you can give value to customer
     } else {
      // this request didn't come from Squad, ignore it
     }
    res.send(200);
```

{% endtab %}

{% tab title="PHP" %}

```
<?php
if ((strtoupper($_SERVER['REQUEST_METHOD']) != 'POST' ) || !array_key_exists('x-squad-signature', $_SERVER) ) 
    exit();
// Retrieve the request's body
$input = @file_get_contents("php://input");
$body = json_decode($input);
define('SQUAD_SECRET_KEY','YOUR_SECRET_KEY'); //ENTER YOUR SECRET KEY HERE

if($_SERVER['x-squad-signature'] !== hash_hmac('sha512',  json_encode($body, JSON_UNESCAPED_SLASHES), SQUAD_SECRET_KEY))
// The Webhook request is not from SQUAD 
    exit();
http_response_code(200);
// The Webhook request is from SQUAD

exit();
?>
```

{% endtab %}

{% tab title="Java" %}

```
package hmacexample;
import java.io.UnsupportedEncodingException;
import java.math.BigInteger;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONException;
import org.json.JSONObject;
public class HMacExample {
  public static void main(String[] args) throws UnsupportedEncodingException, InvalidKeyException, NoSuchAlgorithmException, JSONException {
    //This verifies that the request is from Squad
      
    String key = "YOUR_SECRET_KEY"; //replace with your squad secret_key
    
    String body = "BODY_OF_THE_WEBHOOK_PAYLOAD"; //Replace with body of the webhook payload
    
    String result = "";
    String HMAC_SHA512 = "HmacSHA512";
    String x-squad-signature = ""; //put in the request's header value for x-squad-signature
    
    byte [] byteKey = key.getBytes("UTF-8");
    SecretKeySpec keySpec = new SecretKeySpec(byteKey, HMAC_SHA512);
    Mac sha512_HMAC = Mac.getInstance(HMAC_SHA512);      
    sha512_HMAC.init(keySpec);
    byte [] mac_data = sha512_HMAC.
    doFinal(body.toString().getBytes("UTF-8"));
    result = String.format("%040x", new BigInteger(1, mac_data));
    while (result.length() < 128)  result = "0"+ result;
    if(result.equals(x-squad-signature)) {
      // you can trust that this is from squad
    }else{
      // this isn't from Squad, ignore it
    }  
  }
}
```

{% endtab %}
{% endtabs %}

### Sample Webhook Notification

<pre><code>{
  "transaction_reference": "REF2023022815174720339_1",
  "virtual_account_number": "0733848693",
  "principal_amount": "0.20",
  "settled_amount": "0.20",
  "fee_charged": "0.00",
  "transaction_date": "2023-02-28T00:00:00.000Z",
  "customer_identifier": "5UMKKK3R",
  "transaction_indicator": "C",
  "remarks": "Transfer FROM WILLIAM JAMES | [5UM2B63R] TO CHIZOBA ANTHONY OKOYE",
  "currency": "NGN",
  "channel": "virtual-account",
  "sender_name": "WILLIAM JAMES",
<strong>  "meta": {
</strong>    "freeze_transaction_ref": null,
    "reason_for_frozen_transaction": null
  },
  "encrypted_body": "DiPEa8Z4Cbfiqulhs3Q8lVJXGjMIFzbWwI2g7utVGbiI96TjcbjW+64iQrDR+kbZBwisMLMfB5l+Bn0/9kchGjB+xj6bLc6SnyCaku3pCMKmiVSkr/US1lsk+dBBI53nkGcUFkhige35wBYtXC7IpB/N2DCrzXTW5kEGnr9lCvpEFvDhZzDIUVeUCxV14V92vYYP/8O8Zjj3WR9keUc7Qq0H+fl/jmm7VwCtKMSp0OXNGMVPk5TJkLR52hQ8Rap+oorORLoNau1FRLzA24AW0d+nQfqbI+B4hf5+RztP7F1PpiRlo5qR7EthNpaHW6EMYp9fFUQdJRzsQNLbU/IfnH5oK9zFjHaOfKAa5rnoWP3N5IQjz6wobLq9T2KHei3UpCioFMcKYoigtJxple26auq0vCDkDoalPF6+YaqpuKFWdjX0mLz9+Xh5OCq4AI4u3GhioYFbpAvkrzk/Eyh5OdrEvDDLsbSu8lnXymOoiYXuS1Y4Y5jVZpzAArJ7wX7rdi1KLawHu8/m6fBkQLq/82olUuGLtGdPKF1JZnbv3eAXa7+IMhF4QUvsd52uMRnBdEHXfij+WHp7mz4jMP4Gxsx19Xzt7gyWqBhyswEJobDMSZhk/9GRcETwnT0dlSlWxVOL2pVSzKhc73ASxEQCZCO3/5/i1Nq6qSTjsbplLKuwP2Qr/15rP6TvVWAIpxa8"
}
</code></pre>

**Note:** You are expected to send us a response confirming receipt of the request

{% tabs %}
{% tab title="200: Successful" %}

```
{
    response_code:200,
    transaction_reference: 'unique reference sent through the post',
    response_description: 'Success'
}
```

{% endtab %}

{% tab title="400: Validation Failure" %}

```
{
    response_code:400,
    transaction_reference: 'unique reference sent through the post',
    response_description: 'Validation failure'
}
```

{% endtab %}

{% tab title="500: System Malfunction" %}

```
{
    response_code:500,
    transaction_reference: 'unique reference sent through the post',
    response_description: 'System malfunction'
}
```

{% endtab %}
{% endtabs %}

## WEBHOOK VALIDATION V2

The Webhook Version 2 (V2) is an upgrade to the existing version. It follows the same structure with 2 critical updates

1. The addition of a new field (Version Number)
2. The Method of Hash Validation: Unlike previous versions, which required the hashing of the entire payload, the webhook v2 only requires the hashing of six (6) fields, each separated by a pipe (|). The values to be hashed are:&#x20;

   ```
   transaction_reference
   virtual_account_number
   currency
   principal_amount
   settled_amount
   customer_identifier
   ```

## WEBHOOK VALIDATION V3

The Webhook Version 3 (V3) is an upgrade to the existing version. It follows the same structure with 3 critical updates

1. The Transaction Ref follows a different format (N.b. Re-queries were necessary, are to be done with the previous format)
2. The addition of a new field (Version Number)
3. The Method of Hash Validation: Unlike previous versions, which required the hashing of the entire payload, the webhook v3 only requires the hashing of six (6) fields, each separated by a pipe (|). The values to be hashed are:&#x20;

   ```
   transaction_reference
   virtual_account_number
   currency
   principal_amount
   settled_amount
   customer_identifier
   ```

#### Sample pipe (JavaScript)

```
signature = `${payload.transaction_reference}|${payload.virtual_account_number}|${payload.currency}|${payload.principal_amount}|${payload.settled_amount}|${payload.customer_identifier}`;
```

The webhook notification sent carries the x-squad-signature in the header. The hash value (x-squad-signature) is an HMAC SHA512 signature of the webhook payload signed using your secret key.\
\
You are expected to create a hash and compare the value of the hash created with the hash sent in the header of the POST request sent to your webhook URL.<br>

### Sample Webhook V2 & V3 Notification

{% tabs %}
{% tab title="Version 2" %}

```
{
  "transaction_reference": "REF20250711S87136566_M01072312_0740379575",
  "virtual_account_number": "0740379575",
  "principal_amount": "100.00",
  "settled_amount": "99.80",
  "fee_charged": "0.20",
  "transaction_date": "2025-07-11T10:08:43+01:00",
  "customer_identifier": "P7SJ3KMH",
  "transaction_indicator": "C",
  "remarks": "074037957507361965461000020250711100837432 FROM UDOUSORO WILLIAM JOSEPH TO TECHZ /UDOUSORO  WILLIAM JOSEPH | [P7SJ3KMH]",
  "currency": "NGN",
  "channel": "virtual-account",
  "sender_name": "UDOUSORO WILLIAM JOSEPH",
  "meta": {
    "freeze_transaction_ref": null,
    "reason_for_frozen_transaction": null
  },
  "version": "v2",
  "transaction_uuid": "0197F8BE8075AF46",
  "encrypted_body": "4eDIvGkwNhH+u0HgAJB2c+4NnFnr2KmzNB3XU6dLC4tDcnvm9b8d0r1lgyoLZsyU3rZJcnpW/G4e1Vt5MCSS8wKDNuyot+80tZWR62GIzRgZJKLjld2JWPx+CqqRsaOA5ZfHZdty2k5FuzfjfsUf7ISh72cd5/Qt6ofcW0Z5ySGRUrtndMd+62CcoPS0FUl42LoR14tKvIF4OCR2mgZinZYohD0/60oUx5VXugSC2RtLaaDnw79rfBnDr5scbFKG0FQ3bJ4I/WoRwa1mBn7NdTqrWIb1uUtETjdlSztMMVZKKSmePPvejCXAX4u/iVk4/qeeePw45twTeL8Cpfc6PbeXIGyuE7AOFiS2++mgVUpjs8JUpfFXl6BJC+IspJ3yj5kihZdAK4jfdzPR973N+dDFLPt18JKmoBtaMCqj6sxr74xLn1AvGuPu24TbNDHVkYeb0uvCX+G1wI8Q9I1HRsaPdwOmdeFKcbUo5qSx3zT66a31OUroHwE58zf4pRgL8FthOxYm6N1J/NPMimhw6OlE2wl08sXFuYRo3R+/PV/K0QKSkmaB9lGsMk6qK+o++odn15FkLXhp5I9ZKf2fY/9rPDmjUuX0IET6nDN+pJJAl1TZuQuyD58z/R8mT9WU2kfVKtjsK9/VugZ1L+nkshp0nRYZ3W/u82hyH2y1IoYCzR9XdyzicGeAmXNOa0b/LTz5w3M7nkmrlgpwCXGSXJesGgqo/qObdbn912J74C+PSrrETrIhpkjY6w2NZQiNdl8UnlAoO9bQFHyNsUZB6A2WnzuqzqPVpoebVvOAb4Sg7lk8o4IX9lsMG11KLgAJa4FrRsyJs/2P2JbwyGDnDA=="
}
```

{% endtab %}

{% tab title="Version 3" %}

```
{
  "transaction_reference": "0196F220EA4148F3",
  "virtual_account_number": "0712714141",
  "principal_amount": "45000.00",
  "settled_amount": "44955.00",
  "fee_charged": "45.00",
  "transaction_date": "2025-05-21T10:16:05+01:00",
  "customer_identifier": "RRRR",
  "transaction_indicator": "C",
  "remarks": "100004230823134654105988596264|090701365374||EUSTACE UGOCHUKWU NJOKU || REF:989898999888998898989899 | [RRRR]",
  "currency": "NGN",
  "channel": "virtual-account",
  "sender_name": "Transfer",
  "meta": {
    "freeze_transaction_ref": null,
    "reason_for_frozen_transaction": null
  },
  "version": "v3",
  "encrypted_body": "4eDIvGkwNhH+u0HgAJB2c3GKIKnweltSZso1o/otX3x+8LXQti6+FtCqbHhrSy8RNk1wB3oWswWbY1qq5+C2QN2kA9ogIM4P0uGqciTClxQVtKaAZCaAGjWr0vmqt928oyop6WJ3jzqTGnQwheAm9ITNAnbXgShfPtmOMtJyWAKwR+QNQyoZjdArQKqJzm5RxbI/iHp2ZmJpgr0229AREiahdIhy80sRO7ztHD4M1QmYBXrzElrcJ85ZtAFM41DsUtqojeW0eR8kWw8ghTHmL5rmCD0sselidmC7NFpiIpn3RuHOBNYXfcVU38+LVdBPmNygFd9iX2n0kxxLMBX9X4ngQDiaR6faKo2rOJ0/KXg44YM/y/dYVHsjBHqZXuB252FoZk7bUKbW6ebPXIuEkgjB63El/BcbLXtbjrw0w3ybXqY6pVahi8SuURJe7DcglS8IITacYybcjfoZYsiKCJKZqlb2pkLCCoNpaEEEqa8dP0b3QdisDiTy3vvWB1nGuxPjk9kPWr/IxqP9/NbPoWN4MRVU6PsmPHhHyd3tiUWfPCMBAT9EB7ldjHl8tpVGjKRkGzvVuuc9tm8c6gPPotW9/M3SnKgm23becDp/hGMaA0PbFwVs7h+JjWMu3UcHlujFUqHRDA/TZ5Vvp8uT2ZDc5y+wisUntKW3F+gBv0mL+ifagi/PJRXOYXdG4oIEUw/Jy7bdY+JrGbBmsS8RhOkbIcFf4ClU2cnHB5h/6TA="
}
```

{% endtab %}
{% endtabs %}

### Sample Implementations

{% tabs %}
{% tab title="C#" %}

```
using System;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;

// Expected signature from the header
const string ExpectedSignature = "64cab69cecb62ad24da041789847a070e93621071fcbd84ccf975150b820dcb1a1eaeae00bb9be976007cad4eeaa83e01d201b3fc28c7dfeb27834939a5bc755";

// Secret key for HMAC
const string SecretKey = "user_sk_sample-secret-key-1";

// Sample payload
var payload = new
{
    transaction_reference = "0196F220EA4148F3",
    virtual_account_number = "0712714141",
    principal_amount = "45000.00",
    settled_amount = "44955.00",
    fee_charged = "45.00",
    transaction_date = "2025-05-21T10:16:05+01:00",
    customer_identifier = "RRRR",
    transaction_indicator = "C",
    remarks = "100004230823134654105988596264|090701365374||EUSTACE UGOCHUKWU NJOKU || REF:989898999888998898989899 | [RRRR]",
    currency = "NGN",
    channel = "virtual-account",
    sender_name = "Transfer",
    meta = new
    {
        freeze_transaction_ref = (string)null,
        reason_for_frozen_transaction = (string)null
    },
    version = "v3",
    encrypted_body = "4eDIvGkwNhH+u0HgAJB2c3GKIKnweltSZso1o/otX3x+8LXQti6+FtCqbHhrSy8RNk1wB3oWswWbY1qq5+C2QN2kA9ogIM4P0uGqciTClxQVtKaAZCaAGjWr0vmqt928oyop6WJ3jzqTGnQwheAm9ITNAnbXgShfPtmOMtJyWAKwR+QNQyoZjdArQKqJzm5RxbI/iHp2ZmJpgr0229AREiahdIhy80sRO7ztHD4M1QmYBXrzElrcJ85ZtAFM41DsUtqojeW0eR8kWw8ghTHmL5rmCD0sselidmC7NFpiIpn3RuHOBNYXfcVU38+LVdBPmNygFd9iX2n0kxxLMBX9X4ngQDiaR6faKo2rOJ0/KXg44YM/y/dYVHsjBHqZXuB252FoZk7bUKbW6ebPXIuEkgjB63El/BcbLXtbjrw0w3ybXqY6pVahi8SuURJe7DcglS8IITacYybcjfoZYsiKCJKZqlb2pkLCCoNpaEEEqa8dP0b3QdisDiTy3vvWB1nGuxPjk9kPWr/IxqP9/NbPoWN4MRVU6PsmPHhHyd3tiUWfPCMBAT9EB7ldjHl8tpVGjKRkGzvVuuc9tm8c6gPPotW9/M3SnKgm23becDp/hGMaA0PbFwVs7h+JjWMu3UcHlujFUqHRDA/TZ5Vvp8uT2ZDc5y+wisUntKW3F+gBv0mL+ifagi/PJRXOYXdG4oIEUw/Jy7bdY+JrGbBmsS8RhOkbIcFf4ClU2cnHB5h/6TA="
};

// formatted string with pipe separators
string dataToHash = $"{payload.transaction_reference}|{payload.virtual_account_number}|{payload.currency}|{payload.principal_amount}|{payload.settled_amount}|{payload.customer_identifier}";

Console.WriteLine($"Data to hash (with pipe separators): {dataToHash}");

// hash using HMAC-SHA512 with the secret key
string generatedHash = GenerateHmacSHA512(dataToHash, SecretKey);

Console.WriteLine($"Generated hash: {generatedHash}");
Console.WriteLine($"Expected hash:  {ExpectedSignature}");
Console.WriteLine($"Hashes match: {generatedHash == ExpectedSignature}");


// HMAC-SHA512 with secret key
static string GenerateHmacSHA512(string input, string key)
{
    byte[] keyBytes = Encoding.UTF8.GetBytes(key);
    byte[] inputBytes = Encoding.UTF8.GetBytes(input);

    using HMACSHA512 hmac = new HMACSHA512(keyBytes);
    byte[] hashBytes = hmac.ComputeHash(inputBytes);

    // Convert the byte array to a hexadecimal string
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < hashBytes.Length; i++)
    {
        sb.Append(hashBytes[i].ToString("x2"));
    }

    return sb.ToString();
}
```

{% endtab %}

{% tab title="PHP" %}

```
<?php
// Expected signature from the header
$expectedSignature = "64cab69cecb62ad24da041789847a070e93621071fcbd84ccf975150b820dcb1a1eaeae00bb9be976007cad4eeaa83e01d201b3fc28c7dfeb27834939a5bc755";
// Secret key for HMAC
$secretKey = "user_sk_sample-secret-key-1";
// Sample payload
$payload = [
    "transaction_reference" => "0196F220EA4148F3",
    "virtual_account_number" => "0712714141",
    "principal_amount" => "45000.00",
    "settled_amount" => "44955.00",
    "fee_charged" => "45.00",
    "transaction_date" => "2025-05-21T10:16:05+01:00",
    "customer_identifier" => "RRRR",
    "transaction_indicator" => "C",
    "remarks" => "100004230823134654105988596264|090701365374||EUSTACE UGOCHUKWU NJOKU || REF:989898999888998898989899 | [RRRR]",
    "currency" => "NGN",
    "channel" => "virtual-account",
    "sender_name" => "Transfer",
    "meta" => [
        "freeze_transaction_ref" => null,
        "reason_for_frozen_transaction" => null
    ],
    "version" => "v3",
    "encrypted_body" => "4eDIvGkwNhH+u0HgAJB2c3GKIKnweltSZso1o/otX3x+8LXQti6+FtCqbHhrSy8RNk1wB3oWswWbY1qq5+C2QN2kA9ogIM4P0uGqciTClxQVtKaAZCaAGjWr0vmqt928oyop6WJ3jzqTGnQwheAm9ITNAnbXgShfPtmOMtJyWAKwR+QNQyoZjdArQKqJzm5RxbI/iHp2ZmJpgr0229AREiahdIhy80sRO7ztHD4M1QmYBXrzElrcJ85ZtAFM41DsUtqojeW0eR8kWw8ghTHmL5rmCD0sselidmC7NFpiIpn3RuHOBNYXfcVU38+LVdBPmNygFd9iX2n0kxxLMBX9X4ngQDiaR6faKo2rOJ0/KXg44YM/y/dYVHsjBHqZXuB252FoZk7bUKbW6ebPXIuEkgjB63El/BcbLXtbjrw0w3ybXqY6pVahi8SuURJe7DcglS8IITacYybcjfoZYsiKCJKZqlb2pkLCCoNpaEEEqa8dP0b3QdisDiTy3vvWB1nGuxPjk9kPWr/IxqP9/NbPoWN4MRVU6PsmPHhHyd3tiUWfPCMBAT9EB7ldjHl8tpVGjKRkGzvVuuc9tm8c6gPPotW9/M3SnKgm23becDp/hGMaA0PbFwVs7h+JjWMu3UcHlujFUqHRDA/TZ5Vvp8uT2ZDc5y+wisUntKW3F+gBv0mL+ifagi/PJRXOYXdG4oIEUw/Jy7bdY+JrGbBmsS8RhOkbIcFf4ClU2cnHB5h/6TA="
];

// formatted string with pipe separators
$dataToHash = $payload["transaction_reference"] . "|" . 
              $payload["virtual_account_number"] . "|" . 
              $payload["currency"] . "|" . 
              $payload["principal_amount"] . "|" . 
              $payload["settled_amount"] . "|" . 
              $payload["customer_identifier"];

echo "Data to hash (with pipe separators): " . $dataToHash . PHP_EOL;

// hash using HMAC-SHA512 with the secret key
$generatedHash = generateHmacSHA512($dataToHash, $secretKey);

echo "Generated hash: " . $generatedHash . PHP_EOL;
echo "Expected hash:  " . $expectedSignature . PHP_EOL;
echo "Hashes match: " . ($generatedHash === $expectedSignature ? "true" : "false") . PHP_EOL;

/**
 * HMAC-SHA512 hash with secret key
 * 
 * @param string $input The input string to hash
 * @param string $key The secret key
 * @return string The hexadecimal hash string
 */
function generateHmacSHA512($input, $key) {
    $hash = hash_hmac('sha512', $input, $key, false);
    return $hash;
}
?>
```

{% endtab %}

{% tab title="JavaScript" %}

```
const crypto = require('crypto');

//signature from the header
const expectedSignature = "64cab69cecb62ad24da041789847a070e93621071fcbd84ccf975150b820dcb1a1eaeae00bb9be976007cad4eeaa83e01d201b3fc28c7dfeb27834939a5bc755";
// Secret key for HMAC
const secretKey = "user_sk_sample-secret-key-1";
// Sample payload
const payload = {
    transaction_reference: "0196F220EA4148F3",
    virtual_account_number: "0712714141",
    principal_amount: "45000.00",
    settled_amount: "44955.00",
    fee_charged: "45.00",
    transaction_date: "2025-05-21T10:16:05+01:00",
    customer_identifier: "RRRR",
    transaction_indicator: "C",
    remarks: "100004230823134654105988596264|090701365374||EUSTACE UGOCHUKWU NJOKU || REF:989898999888998898989899 | [RRRR]",
    currency: "NGN",
    channel: "virtual-account",
    sender_name: "Transfer",
    meta: {
        freeze_transaction_ref: null,
        reason_for_frozen_transaction: null
    },
    version: "v3",
    encrypted_body: "4eDIvGkwNhH+u0HgAJB2c3GKIKnweltSZso1o/otX3x+8LXQti6+FtCqbHhrSy8RNk1wB3oWswWbY1qq5+C2QN2kA9ogIM4P0uGqciTClxQVtKaAZCaAGjWr0vmqt928oyop6WJ3jzqTGnQwheAm9ITNAnbXgShfPtmOMtJyWAKwR+QNQyoZjdArQKqJzm5RxbI/iHp2ZmJpgr0229AREiahdIhy80sRO7ztHD4M1QmYBXrzElrcJ85ZtAFM41DsUtqojeW0eR8kWw8ghTHmL5rmCD0sselidmC7NFpiIpn3RuHOBNYXfcVU38+LVdBPmNygFd9iX2n0kxxLMBX9X4ngQDiaR6faKo2rOJ0/KXg44YM/y/dYVHsjBHqZXuB252FoZk7bUKbW6ebPXIuEkgjB63El/BcbLXtbjrw0w3ybXqY6pVahi8SuURJe7DcglS8IITacYybcjfoZYsiKCJKZqlb2pkLCCoNpaEEEqa8dP0b3QdisDiTy3vvWB1nGuxPjk9kPWr/IxqP9/NbPoWN4MRVU6PsmPHhHyd3tiUWfPCMBAT9EB7ldjHl8tpVGjKRkGzvVuuc9tm8c6gPPotW9/M3SnKgm23becDp/hGMaA0PbFwVs7h+JjWMu3UcHlujFUqHRDA/TZ5Vvp8uT2ZDc5y+wisUntKW3F+gBv0mL+ifagi/PJRXOYXdG4oIEUw/Jy7bdY+JrGbBmsS8RhOkbIcFf4ClU2cnHB5h/6TA="
};

// String with pipe separators
const dataToHash = `${payload.transaction_reference}|${payload.virtual_account_number}|${payload.currency}|${payload.principal_amount}|${payload.settled_amount}|${payload.customer_identifier}`;

console.log(`Data to hash (with pipe separators): ${dataToHash}`);

// Hash using HMAC-SHA512 with the secret key
const generatedHash = generateHmacSHA512(dataToHash, secretKey);

console.log(`Generated hash: ${generatedHash}`);
console.log(`Expected hash:  ${expectedSignature}`);
console.log(`Hashes match: ${generatedHash === expectedSignature}`);

/**
 * Generate HMAC-SHA512 hash with secret key
 * 
 * @param {string} input The input string to hash
 * @param {string} key The secret key
 * @return {string} The hexadecimal hash string
 */
function generateHmacSHA512(input, key) {
    const hmac = crypto.createHmac('sha512', key);
    hmac.update(input);
    return hmac.digest('hex');
}
```

{% endtab %}
{% endtabs %}

## WEBHOOK ERROR LOG

This API allows you to retrieve all your missed webhook transactions and use it to update your record without manual input.<br>

* The top 100 missed webhooks will always be returned by default and it
* This flow involves integration of two(2) APIs
* Once you have updated the record of a particular transaction, you are expected to use the second API to delete the record from the error log. If this is not done, the transaction will continuously be returned to you in the first 100 transactions until you delete it.
* This will only work for those who respond correctly to our webhook calls.
* **Also, ensure you have a transaction duplicate checker to ensure you don't update a record twice or update a record you have updated using the webhook or the transaction API.**

{% hint style="warning" %}
**Authorization** Any request made without the authorization key (secret key) will fail with a **`401`**` ``(Unauthorized)` response code.
{% endhint %}

{% hint style="info" %}
**The authorization key is sent via the request header as Bearer Token Authorization**
{% endhint %}

**Example:**\
Authorizatio&#x6E;**:** Bearer sandbox\_sk\_94f2b798466408ef4d19e848ee1a4d1a3e93f104046f

### Get Webhook Error Log

## This API returns an array of transactions from the webhook error log

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/webhook/logs`

#### Query Parameters

| Name    | Type    | Description                                    |
| ------- | ------- | ---------------------------------------------- |
| page    | Integer | The page you are on                            |
| perPage | Integer | Number of records you want to appear on a page |

{% tabs %}
{% tab title="200: OK " %}

```json
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "count": 2,
        "rows": [
            {
                "id": "229f9f3d-53e4-450e-a9e9-164a8b882a60",
                "payload": {
                    "hash": "659c24ba0b6c3ac324b587f2f079c8ee876c56609ff11b7106cd868f84674a5c37fcb088373859f8d900713f03c47d819de79623cde67e70bbca945fd20f3cb3",
                    "meta": {
                        "freeze_transaction_ref": null,
                        "reason_for_frozen_transaction": null
                    },
                    "channel": "virtual-account",
                    "remarks": "Transfer FROM OKOYE, CHIZOBA ANTHONY | [CCtyttytC] TO CHIZOBA ANTHONY OKOYE",
                    "currency": "NGN",
                    "fee_charged": "0.05",
                    "sender_name": "OKOYE, CHIZOBA ANTHONY",
                    "encrypted_body": "DiPEa8Z4Cbfiqulhs3Q8lVJXGjMIFzbWwI2g7utVGbhXihbtK3H2xsA/+ZnjOpFA0AU8vAN5LUTEH6elfrK58ub2wydaRk0ngvQXWUFz3iB19qWBcdGQRnppKAT/AB5xyy1iQZvEHP7zq3Y7na5zcx9ttkU1mZIeAIoisM9k+ghVLxkTeql4UvfFcLyDdGzMd/BC4YgJFyrZxifhfhKi073od7xJnz4Hhz08UBE/FAwNYMWkwWD9izlbcaaJtfh1VIN6t9rl1gotlb5qmNq/UytgoSvuN5uaEXxegdB3VWvmsDMHqoYwDs4oEuv0lp8zUUG3cZ9zPQ6xH3shGQjVOWErkuIfCk62fRzkwxya4Gu/x2KHMSQjutbvD4vNDjVGfuCIoHuZEXPThWrq1jpTy7cNMLc8ZZ8IowJnfwWHL+O6fuepxXxfrJHlswMCI35ZHSvef1AEXgbUlx2O7yzytceCogpUkY+QJ1yLddl1FeE1u2JKOM+casP3pfiT+t3Mv55aSCVQO7hUy46gd6H/bIHaSIp2K3CcjfdflZ/bxCZaZoe/sRqfVdVIzpSpTc0Lq5sOXM2gijOdeg+zex/CgnMIKGJdzUT9YUJtaaVrMmhk0EcM0rHRrqs0iM7xaSTdZ7K8hnzl0RPJhDXIhu5a/Y2NxS3ZTC2lYRVZd6I3lerpoMQG69VfmqvaVgW2k03f",
                    "settled_amount": "49.95",
                    "principal_amount": "50.00",
                    "transaction_date": "2023-09-01T00:00:00.000Z",
                    "customer_identifier": "CCtyttytC",
                    "transaction_indicator": "C",
                    "transaction_reference": "REF20230901162737156459_1",
                    "virtual_account_number": "0760640237"
                },
                "transaction_ref": "REF20230901162737156459_1"
            }
        ]
    }
}
```

{% endtab %}

{% tab title="401: Unauthorized No Authorization" %}

```
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

### Delete Webhook Error Log

## This API enables you delete a processed transaction from the webhook error log

<mark style="color:red;">`DELETE`</mark> `https://sandbox-api-d.squadco.com/virtual-account/webhook/logs/:transaction_ref`

When you delete the transaction from the log, it won't be returned to you again. Failure to delete a transaction will result in the transaction being returned to you in the top 100 transactions returned each time you retry.

#### Path Parameters

| Name                                               | Type   | Description                                                                                                 |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| transaction\_ref<mark style="color:red;">\*</mark> | String | Unique Transaction Ref that identifies each virtual account and gotten from the retrieved webhook error log |

{% tabs %}
{% tab title="200: OK Success" %}

```
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": 1
}
```

{% endtab %}

{% tab title="401: Unauthorized No Authorization" %}

```
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}

{% tab title="403: Forbidden Wrong/Invalid API Keys" %}

```
{
    "success": false,
    "message": "Merchant authentication failed",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

### Query Customer Transaction by Customer Identifier

This is an endpoint to query the transactions a customer has made. This is done using the customer's identifier which was passed when creating the virtual account.

## Query Customer Transactions

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/customer/transactions/{{customer_identifier}}`

**Note**: The customer identifier is to be passed via the endpoint being queried.\
That is: replace {{customer\_identifier}} on the end point with the customer identifier of the customer whose transactions you want to query.

#### Path Parameters

| Name                 | Type   | Description                                                     |
| -------------------- | ------ | --------------------------------------------------------------- |
| customer\_identifier | String | Unique Customer Identifier that identifies each virtual account |

Response expected from the API to show queried Virtual Accounts.

{% tabs %}
{% tab title="200: Successful" %}

```
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": [
        {
            "transaction_reference": "74902084jjjfksoi93004891_1",
            "virtual_account_number": "2224449991",
            "principal_amount": "30000.00",
            "settled_amount": "0.00",
            "fee_charged": "0.00",
            "transaction_date": "2022-04-21T09:00:00.000Z",
            "transaction_indicator": "C",
            "remarks": "Payment from 10A2 to 2224449991",
            "currency": "NGN",
            "frozen_transaction": {
                "freeze_transaction_ref": "afbd9b7f-fb98-41c3-bfe8-dc351cfb45c7",
                "reason": "Amount above 20000 when BVN not set"
            },
            "customer": {
                "customer_identifier": "SBN1EBZEQ8"
            }
        },
{
            "transaction_reference": "676767_1",
            "virtual_account_number": "2224449991",
            "principal_amount": "1050.00",
            "settled_amount": "1037.00",
            "fee_charged": "13.00",
            "transaction_date": "2022-03-21T09:00:00.000Z",
            "transaction_indicator": "C",
            "remarks": "Payment from 10A2 to 2224449991",
            "currency": "NGN",
            "froze_transaction": null,
            "customer": {
                "customer_identifier": "SBN1EBZEQ8"
            }
        }
    ]
}
```

{% endtab %}

{% tab title="400: Validation Failure" %}
{\
&#x20;   "status": 400,\
&#x20;   "success": **false**,\
&#x20;   "message": "Customer identifier or merchant identifier is required",\
&#x20;   "data": {}\
}
{% endtab %}

{% tab title="401: Restricted" %}
{\
&#x20;   "status": 401,\
&#x20;   "success": **false**,\
&#x20;   "message": "Merchant has been restricted, please contact Habaripay support",\
&#x20;   "data": {}\
}
{% endtab %}

{% tab title="404: Not Found" %}

{% endtab %}
{% endtabs %}

### Query All Merchant's Transactions

This is an endpoint to query all the merchant transactions over a period of time.

## Query All Transactions

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/merchant/transactions`

Note: The endpoint is to be queried using just the authorization key from the dashboard

{% tabs %}
{% tab title="200: Successful" %}

```
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": [
        {
            "transaction_reference": "4894fe1_1",
            "virtual_account_number": "2244441333",
            "principal_amount": "5000.00",
            "settled_amount": "0.00",
            "fee_charged": "0.00",
            "transaction_date": "2022-04-21T09:00:00.000Z",
            "transaction_indicator": "C",
            "remarks": "Payment from 15B8 to 2244441333",
            "currency": "NGN",
            "frozen_transaction": {
                "freeze_transaction_ref": "afbd9b7f-fb98-41c3-bfe8-dc351cfb45c7",
                "reason": "Amount above 20000 when BVN not set"
            },
            "customer": {
                "customer_identifier": "SBN1EBZEQ8"
            }
        },
{
            "transaction_reference": "676767_1",
            "virtual_account_number": "2224449991",
            "principal_amount": "30000.00",
            "settled_amount": "1037.00",
            "fee_charged": "13.00",
            "transaction_date": "2022-03-21T09:00:00.000Z",
            "transaction_indicator": "C",
            "remarks": "Payment from 10A2 to 2224449991",
            "currency": "NGN",
            "froze_transaction": null,
            "customer": {
                "customer_identifier": "SBN1EBZEQ8"
            }
        }
    ]
}
```

{% endtab %}

{% tab title="400: Validation Failure " %}
{\
&#x20;   "status": 400,\
&#x20;   "success": **false**,\
&#x20;   "message": "Merchant identifier is required",\
&#x20;   "data": {}\
}
{% endtab %}

{% tab title="401: Restricted" %}
{\
&#x20;   "status": 401,\
&#x20;   "success": **false**,\
&#x20;   "message": "Merchant has been restricted, please contact Habaripay support",\
&#x20;   "data": {}\
}
{% endtab %}

{% tab title="404: Not Profiled" %}
{\
&#x20;   "status": 404,\
&#x20;   "success": **false**,\
&#x20;   "message": "Merchant is not profiled for this service, please contact Habaripay support",\
&#x20;   "data": {}\
}
{% endtab %}
{% endtabs %}

## Query Single Transaction Using Transaction Ref

This endpoint allows you to query a single transaction using the system-generated transaction reference, which can be obtained from the webhook notification or dashboard.

<mark style="color:blue;">`GET`</mark> [`https://api-d.squadco.com/virtual-account/merchant/transactions/all?transactionReference=REF202409181544489320003`](https://api-d.squadco.com/virtual-account/merchant/transactions/all?transactionReference=REF20240918154448932692)

The Ref to be inputted should be your unique ref

#### Query Parameters

| Name                 | Type   | Description                        |
| -------------------- | ------ | ---------------------------------- |
| transactionReference | String | Unique Identifier of a transaction |

{% tabs %}
{% tab title="200: OK Success" %}

```json
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "count": 1,
        "rows": [
            {
                "transaction_reference": "REF202409181544489320003",
                "virtual_account_number": "0915079300",
                "principal_amount": "102.00",
                "settled_amount": "101.74",
                "fee_charged": "0.26",
                "transaction_date": "2024-09-18T00:00:00.000Z",
                "transaction_indicator": "C",
                "remarks": "Transfer FROM TEST ACCOUNT | [0915079300] TO UDOUSORO  WILLIAM JOSEPH",
                "currency": "NGN",
                "alerted_merchant": true,
                "merchant_settlement_date": "2024-09-18T14:45:56.290Z",
                "sender_name": "TEST ACCOUNT",
                "session_id": "100004240918144254119476359000",
                "frozen_transaction": null,
                "customer": {
                    "customer_identifier": "bde0810e-bf42-4dd1-a1d9-31a953b25000"
                },
                "virtual_account": {
                    "account_type": "dynamic"
                }
            }
        ],
        "query": {
            "transactionReference": "REF202409181544489320003"
        }
    }
}
```

{% endtab %}

{% tab title="401: Unauthorized No API Keys" %}

```json
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}

{% tab title="400: Bad Request Wrong/ Invalid Input" %}

```json
{
    "status": 400,
    "success": false,
    "message": "\"virtualAccount\" is not allowed to be empty",
    "data": {}
}
```

{% endtab %}

{% tab title="403: Forbidden Invalid Keys/Token" %}

```json
{
    "success": false,
    "message": "Merchant authentication failed",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

## Get Customer Details by Virtual Account Number

This is an endpoint to retrieve the details of a `customer` using the Virtual Account Number

## Retrieve Virtual Account Details

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/customer/{{virtual_account_number}}`

**Note**: The virtual account number is to be passed via the endpoint being queried.\
That is: replace {{virtual\_account\_number}} on the end point with the virtual account number whose details you want to retrieve.

#### Path Parameters

| Name                                                       | Type   | Description                                                   |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| virtual\_account\_number<mark style="color:red;">\*</mark> | String | Unique 10-digit virtual account number assigned to a customer |

{% tabs %}
{% tab title="200: OK Valid Virtual Account Number" %}

```javascript
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "first_name": "Timothy",
        "last_name": "Oke",
        "mobile_num": "08000000000",
        "email": "atioke@gmail.com",
        "customer_identifier": "CCtyttytC",
        "virtual_account_number": "0686786837"
    }
}
```

{% endtab %}

{% tab title="404: Not Found Invalid Virtual Account Number" %}

```javascript
{
    "status": 404,
    "success": false,
    "message": "Virtual account not found",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

### Get Customer Details Using Customer Identifier

This is an endpoint to retrieve the details of a `customer's`virtual account using the Customer Identifier

## Retrieve Virtual Account Details

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/{{customer_identifier}}`

**Note**: The customer\_identifier is to be passed via the endpoint being queried.\
That is: replace {{customer\_identifier}} on the end point with the customer identifier of the customer whose virtual account you want to retrieve.

#### Path Parameters

| Name                 | Type   | Description                                                     |
| -------------------- | ------ | --------------------------------------------------------------- |
| customer\_identifier | String | Unique Customer Identifier that identifies each virtual account |

{% tabs %}
{% tab title="200: Successful" %}

```
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "first_name": "Wisdom",
        "last_name": "Trudea",
        "bank_code": "737",
        "virtual_account_number": "555666777",
        "customer_identifier": "10D2",
        "created_at": "2022-01-13T11:03:54.252Z",
        "updated_at": "2022-01-13T11:09:51.657Z"
    }
}
```

{% endtab %}

{% tab title="400: Validation Failure " %}

```
{
    "status": 400,
    "success": false,
    "message": "Merchant identifier is required",
    "data": {},

}
```

{% endtab %}

{% tab title="404: Not Profiled" %}

```
{
    "status": 404,
    "success": false,
    "message": "No virtual account is associated",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

### Query All Merchant's Virtual Accounts

This is an endpoint to look-up the virtual account numbers related to a `merchant.`

## Find All Virtual Account Number by Merchant

<mark style="color:blue;">`GET`</mark> `https://sandbox-api-d.squadco.com/virtual-account/merchant/accounts`

This is an endpoint for merchants to query and retrieve all their virtual account.

#### Query Parameters

| Name      | Type   | Description                                |
| --------- | ------ | ------------------------------------------ |
| page      | String | Number of Pages                            |
| perPage   | String | Number of Accounts to be returned per page |
| startDate | Date   | YY-MM-DD                                   |
| EndDate   | Date   | YY-MM-DD                                   |

{% tabs %}
{% tab title="200: Successful" %}

```
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": [
        {
            "bank_code": "058",
            "virtual_account_number": "2224449991",
            "beneficiary_account": "4829023412",
            "created_at": "2022-02-09T16:02:39.170Z",
            "updated_at": "2022-02-09T16:02:39.170Z",
            "customer": {
                "first_name": "Ifeanyi",
                "last_name": "Igweh",
                "customer_identifier": "10A2"
            }
        },
        {
            "bank_code": "058",
            "virtual_account_number": "111444999",
            "beneficiary_account": "9829023411",
            "created_at": "2022-02-09T16:02:39.170Z",
            "updated_at": "2022-02-09T16:02:39.170Z",
            "customer": {
                "first_name": "Paul",
                "last_name": "Aroso",
                "customer_identifier": "10B2"
            }
        }
    ]
}
```

{% endtab %}

{% tab title="404: Not Profiled" %}

```
{
    "status": 400,
    "success": false,
    "message": "Merchant identifier is required",
    "data": {},
}
```

{% endtab %}
{% endtabs %}

### Update Beneficiary Account

### Sample Request

```postman_json
{
    "beneficiary_account":"1111111111",
    "virtual_account_number": "4683366555"  
}
```

## This is used to update beneficiary account

<mark style="color:purple;">`PATCH`</mark> `https://sandbox-api-d.squadco.com/virtual-account/update/beneficiary/account`

#### Request Body

| Name                                                       | Type   | Description                                                           |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| beneficiary\_account<mark style="color:red;">\*</mark>     | String | 10 digit valid NUBAN account number                                   |
| virtual\_account\_number<mark style="color:red;">\*</mark> | String | The Virtual account number whose beneficiary account is to be updated |

{% tabs %}
{% tab title="200: OK Successful" %}

```javascript
{
    "status": 200,
    "success": true,
    "message": "Success",
    "data": {
        "first_name": "Sheena",
        "last_name": "Grace",
        "virtual_account_number": "3832649897",
        "beneficiary_account": "1234567890",
        "customer_identifier": "2086601683696"
    }
}
```

{% endtab %}

{% tab title="401: Unauthorized No/Invalid API Key" %}

```javascript
{
    "success": false,
    "message": "",
    "data": {}
}
```

{% endtab %}

{% tab title="400: Bad Request Bad Request" %}

```javascript
{
    "status": 400,
    "success": false,
    "message": "\"virtual_account_number\" is required",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

### Simulate Payment

This is an endpoint to `simulate payments`

## Simulate Payment

<mark style="color:green;">`POST`</mark> `https://sandbox-api-d.squadco.com/virtual-account/simulate/payment`

This is an endpoint to `simulate payment`

\*asterisks are required and mandatory.

#### Headers

| Name                                            | Type   | Description                                            |
| ----------------------------------------------- | ------ | ------------------------------------------------------ |
| content-type<mark style="color:red;">\*</mark>  |        | application/json                                       |
| Authorization<mark style="color:red;">\*</mark> | String | Private Key or Secret Key (Gotten from your dashboard) |

#### Request Body

| Name                                                       | Type   | Description                                                    |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| virtual\_account\_number<mark style="color:red;">\*</mark> | String | Virtual Account number of customer that wants to make payment. |
| amount                                                     | String | Simulated Amount                                               |

{% tabs %}
{% tab title="200: OK Successful" %}

```javascript
{
    "success": true,
    "message": "Success",
    "data": {}
}
```

{% endtab %}
{% endtabs %}

## Go Live

To go live, simply:&#x20;

\
1\. Change the base URL for your endpoints from sandbox-api-d.squadco.com to \
api-d.squadco.com

2\. [Sign up on our Live Environment](http://dashboard.squadco.com)

3\. Complete your KYC

4\. Share the Merchant ID with the Technical Account Manager for Profiling

5\. Use the secret keys provided on the dashboard to authenticate your live transactions
