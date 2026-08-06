// Check if control bar element exists in the DOM
const controlBar = document.querySelector('[class*="control"]') || 
                   document.querySelector('[class*="atlas"]') ||
                   document.querySelector('[class*="takeover"]') ||
                   document.querySelector('[id*="control"]');
console.log('Control bar element:', controlBar);
console.log('All elements at bottom:', document.querySelectorAll('body > *'));
