/*!
    * Start Bootstrap - Grayscale v6.0.2 (https://startbootstrap.com/themes/grayscale)
    * Copyright 2013-2020 Start Bootstrap
    * Licensed under MIT (https://github.com/StartBootstrap/startbootstrap-grayscale/blob/master/LICENSE)
    */

    // Tooltip

    $('button').tooltip({
      trigger: 'click',
      placement: 'bottom'
    });

    function setTooltip(btn, message) {
      $(btn).tooltip('hide')
        .attr('data-original-title', message)
        .tooltip('show');
    }

    function hideTooltip(btn) {
      setTimeout(function() {
        $(btn).tooltip('hide');
      }, 500);
    }

    // Clipboard

    var clipboard = new Clipboard('button');

    clipboard.on('success', function(e) {
      setTooltip(e.trigger, 'Copied!');
      hideTooltip(e.trigger);
    });

    clipboard.on('error', function(e) {
      setTooltip(e.trigger, 'Failed!');
      hideTooltip(e.trigger);
    });


    var coll = document.getElementsByClassName("collapsible");
    var i;

    for (i = 0; i < coll.length; i++) {
      coll[i].addEventListener("click", function() {
        this.classList.toggle("active");
        var content = this.nextElementSibling;
        if (content.style.maxHeight){
          content.style.maxHeight = null;
          $(this).text("Click to See Agenda");
        } else {
          content.style.maxHeight = content.scrollHeight + "px";
          $(this).text("High Level Agenda");
        }
      });
    }

    // (function ($) {
    // "use strict"; // Start of use strict
    //
    // // Smooth scrolling using jQuery easing
    // $('a.js-scroll-trigger[href*="#"]:not([href="#"])').click(function () {
    //     if (
    //         location.pathname.replace(/^\//, "") ==
    //             this.pathname.replace(/^\//, "") &&
    //         location.hostname == this.hostname
    //     ) {
    //         var target = $(this.hash);
    //         target = target.length
    //             ? target
    //             : $("[name=" + this.hash.slice(1) + "]");
    //         if (target.length) {
    //             $("html, body").animate(
    //                 {
    //                     scrollTop: target.offset().top - 70,
    //                 },
    //                 1000,
    //                 "easeInOutExpo"
    //             );
    //             return false;
    //         }
    //     }
    // });

    // // Closes responsive menu when a scroll trigger link is clicked
    // $(".js-scroll-trigger").click(function () {
    //     $(".navbar-collapse").collapse("hide");
    // });
    //
    // // Activate scrollspy to add active class to navbar items on scroll
    // $("body").scrollspy({
    //     target: "#mainNav",
    //     offset: 100,
    // });

//     // Collapse Navbar
//     var navbarCollapse = function () {
//         if ($("#mainNav").offset().top > 100) {
//             $("#mainNav").addClass("navbar-shrink");
//         } else {
//             $("#mainNav").removeClass("navbar-shrink");
//         }
//     };
//     // Collapse now if page is not at top
//     navbarCollapse();
//     // Collapse the navbar when page is scrolled
//     $(window).scroll(navbarCollapse);
// })(jQuery); // End of use strict
