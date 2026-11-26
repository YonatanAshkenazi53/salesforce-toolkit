// SFTK IP — identity pairs fixture (source org). 2 Accounts, 3 Contacts each. Safe to re-run.
delete [SELECT Id FROM Account WHERE Name LIKE 'SFTK IP %'];
List<Account> accs = new List<Account>{ new Account(Name = 'SFTK IP Alder'), new Account(Name = 'SFTK IP Birch') };
insert accs;
List<Contact> cons = new List<Contact>();
List<String> firsts = new List<String>{ 'Dana', 'Omar', 'Lena', 'Ravi', 'Mira', 'Theo' };
List<String> lasts = new List<String>{ 'Whitlock', 'Castellan', 'Ferrow', 'Dunmore', 'Hale', 'Okafor' };
for (Integer i = 0; i < 6; i++) cons.add(new Contact(AccountId = accs[Math.mod(i, 2)].Id, FirstName = firsts[i], LastName = lasts[i], Email = firsts[i].toLowerCase() + '.' + lasts[i].toLowerCase() + '@sftk-ip.example', Title = 'SFTK IP ' + (i + 1)));
insert cons;
