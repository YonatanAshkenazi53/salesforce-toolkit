// SFTK IP — remove what a run wrote into the target (the Contacts go with their Accounts).
delete [SELECT Id FROM Account WHERE Name LIKE 'SFTK IP %'];
